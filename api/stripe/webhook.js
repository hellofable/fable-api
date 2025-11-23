import crypto from 'node:crypto';
import { getStripe } from '../../lib/stripe-config.js';
import { log, logSuccessSampled, randomUUID } from '../../logger.js';

let cachedPb;
async function getPocketBase() {
  if (!cachedPb) {
    const PocketBaseModule = await import('pocketbase');
    const PocketBase = PocketBaseModule.default || PocketBaseModule;
    cachedPb = new PocketBase(process.env.POCKETBASE_URL);
  }
  return cachedPb;
}

async function ensurePocketBaseUser(pb, email) {
  const normalized = email.trim().toLowerCase();

  const existing = await pb.collection('users')
    .getFirstListItem(`email="${normalized}"`)
    .catch(() => null);

  if (existing) {
    return existing;
  }

  const password = crypto.randomBytes(24).toString('hex');

  const user = await pb.collection('users').create({
    email: normalized,
    emailVisibility: true,
    password,
    passwordConfirm: password,
  });



  return user;
}

function normalizePlan(plan) {
  const normalized = (plan || '').toLowerCase();
  if (['annual', 'yearly', 'year'].includes(normalized)) {
    return 'annual';
  }
  return 'monthly';
}

async function syncSubscriptionRecord(stripe, pb, subscription, fallbackEmail) {
  if (!subscription?.id) {
    log('warn', 'stripe_sync_skip', { reason: 'missing_subscription_id' });
    return;
  }

  const hasProp = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);
  const toIso = (value) => (value ? new Date(value * 1000).toISOString() : null);

  const metadata = {
    ...subscription.metadata,
  };

  let existing = await pb.collection('subscriptions')
    .getFirstListItem(`stripeSubscriptionId="${subscription.id}"`)
    .catch(() => null);

  let userId = metadata.pocketbase_user_id || existing?.userId;
  let email = metadata.pending_user_email || fallbackEmail || null;

  if (!userId) {
    if (!email && subscription.customer) {
      try {
        const customer = await stripe.customers.retrieve(subscription.customer);
        email = customer?.email || email;
      } catch (err) {
        log('error', 'stripe_sync_customer_fetch_fail', { message: err?.message });
      }
    }

    if (!email) {
      log('warn', 'stripe_sync_missing_email', { subscription_id: subscription.id });
      return;
    }

    // Don't create users for deleted/terminal subscriptions
    const isTerminal = subscription.status === 'canceled'
      || subscription.status === 'incomplete_expired'
      || subscription.status === 'unpaid'
      || subscription.ended_at;

    if (isTerminal) {
      log('info', 'stripe_sync_skip_terminal', { subscription_id: subscription.id });
      return;
    }

    const user = await ensurePocketBaseUser(pb, email);
    userId = user.id;
    metadata.pocketbase_user_id = userId;
    metadata.pending_user_email = email;
  }

  let plan = normalizePlan(
    metadata.plan
    || metadata.selected_plan
    || existing?.plan
    || subscription.items?.data?.[0]?.price?.recurring?.interval
  );

  const cancelAtPeriodEnd = hasProp(subscription, 'cancel_at_period_end')
    ? Boolean(subscription.cancel_at_period_end)
    : existing?.cancel_at_period_end ?? false;
  const cancelAt = hasProp(subscription, 'cancel_at')
    ? toIso(subscription.cancel_at)
    : existing?.cancel_at ?? null;
  const canceledAt = hasProp(subscription, 'canceled_at')
    ? toIso(subscription.canceled_at)
    : existing?.canceled_at ?? null;
  const endedAt = hasProp(subscription, 'ended_at')
    ? toIso(subscription.ended_at)
    : existing?.ended_at ?? null;

  const status = subscription.status || 'trialing';
  const hasValidSub = ['trialing', 'active'].includes(status) && !endedAt;

  const data = {
    userId,
    stripeCustomerId: subscription.customer,
    stripeSubscriptionId: subscription.id,
    status,
    plan,
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : existing?.currentPeriodEnd || null,
    trialEnd: subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : existing?.trialEnd || null,
    cancel_at_period_end: cancelAtPeriodEnd,
    cancel_at: cancelAt,
    canceled_at: canceledAt,
    ended_at: endedAt,
  };

  if (existing) {
    await pb.collection('subscriptions').update(existing.id, data);
  } else {
    // Before creating new subscription, delete any old ones for this user
    const oldRecords = await pb.collection('subscriptions')
      .getFullList({ filter: `userId="${userId}"` });

    for (const old of oldRecords) {
      await pb.collection('subscriptions').delete(old.id);
    }

    existing = await pb.collection('subscriptions').create(data);
  }

  // Update hasValidSub flag on user record
  try {
    await pb.collection('users').update(userId, { hasValidSub });
  } catch (err) {
    log('error', 'stripe_sync_user_update_fail', { user_id: userId, message: err?.message });
  }

  const desiredMetadata = {
    ...metadata,
    plan,
    selected_plan: plan,
    pocketbase_user_id: userId,
    pending_user_email: metadata.pending_user_email || email,
  };

  const shouldUpdateMetadata = JSON.stringify(subscription.metadata || {}) !== JSON.stringify(desiredMetadata);

  if (shouldUpdateMetadata && subscription.status !== 'canceled') {
    try {
      await stripe.subscriptions.update(subscription.id, {
        metadata: desiredMetadata,
      });
    } catch (err) {
      log('error', 'stripe_update_subscription_metadata_fail', { subscription_id: subscription.id, message: err?.message });
    }
  }
}

export const config = {
  api: {
    bodyParser: false, // Stripe needs raw body
  },
};

async function getRawBody(req) {
  // If body-parser's express.raw already parsed the body, use it
  if (req.body && Buffer.isBuffer(req.body)) {
    return req.body;
  }
  // Fallback: manually collect the raw stream
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  const requestId = randomUUID();
  const startTime = Date.now();
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const stripe = getStripe();
  const pb = await getPocketBase();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    log('error', 'stripe_webhook_sig_verify_fail', { request_id: requestId, message: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Authenticate with PocketBase
  await pb.admins.authWithPassword(
    process.env.POCKETBASE_ADMIN_EMAIL,
    process.env.POCKETBASE_ADMIN_PASSWORD
  );

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutComplete(stripe, pb, event.data.object);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(stripe, pb, event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripe, pb, event.data.object);
        break;

      default:
        log('info', 'stripe_webhook_unhandled', { request_id: requestId, event_type: event.type });
    }

    res.status(200).json({ received: true });
  } catch (error) {
    log('error', 'stripe_webhook_error', { request_id: requestId, message: error?.message, event_type: event?.type });
    res.status(500).json({ error: error.message });
  } finally {
    const durationMs = Date.now() - startTime;
    logSuccessSampled('stripe_webhook_ok', { request_id: requestId, event_type: event?.type, duration_ms: durationMs });
    pb.authStore.clear();
  }
}

async function handleCheckoutComplete(stripe, pb, session) {
  const metadata = session.metadata || {};
  let userId = metadata.pocketbase_user_id;
  let plan = metadata.plan || metadata.selected_plan || 'monthly';

  if (!userId) {
    const fallbackEmail = metadata.pending_user_email
      || session.customer_details?.email
      || session.customer_email;

    if (!fallbackEmail) {
      throw new Error('Missing user metadata for checkout session');
    }

    const user = await ensurePocketBaseUser(pb, fallbackEmail);
    userId = user.id;
  }

  plan = plan === 'annual' || plan === 'yearly' ? 'annual' : 'monthly';

  const fallbackEmail = metadata.pending_user_email
    || session.customer_details?.email
    || session.customer_email;

  if (!session.subscription) {
    log('warn', 'stripe_checkout_missing_subscription', { session_id: session?.id });
    return;
  }

  let subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(session.subscription);
  } catch (err) {
    log('error', 'stripe_checkout_retrieve_subscription_fail', { session_id: session?.id, message: err?.message });
  }

  if (!subscription) {
    subscription = {
      id: session.subscription,
      customer: session.customer,
      status: 'trialing',
      metadata: { ...metadata, plan, selected_plan: plan },
      current_period_end: null,
      trial_end: null,
      items: session.items,
    };
  } else {
    subscription.metadata = {
      ...subscription.metadata,
      plan: subscription.metadata?.plan || metadata.plan || metadata.selected_plan || plan,
      selected_plan: subscription.metadata?.selected_plan || metadata.selected_plan || metadata.plan || plan,
      pending_user_email: subscription.metadata?.pending_user_email || metadata.pending_user_email || fallbackEmail,
      pocketbase_user_id: subscription.metadata?.pocketbase_user_id || metadata.pocketbase_user_id || userId,
    };
  }

  await syncSubscriptionRecord(stripe, pb, subscription, fallbackEmail);
}

async function handleSubscriptionUpdate(stripe, pb, subscription) {
  await syncSubscriptionRecord(stripe, pb, subscription);
}

async function handleSubscriptionDeleted(stripe, pb, subscription) {
  await syncSubscriptionRecord(stripe, pb, subscription);
}
