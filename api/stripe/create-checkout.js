import { getStripe, resolvePriceId } from '../../lib/stripe-config.js';
import { applyCORS, handlePreflight } from '../../utils/cors.js';
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

function decodePocketBaseToken(token) {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (error) {
    log('error', 'checkout_decode_token_fail', { message: error?.message });
    return null;
  }
}

export default async function handler(req, res) {
  const requestId = randomUUID();
  const startTime = Date.now();
  // Handle CORS preflight
  if (handlePreflight(req, res)) {
    return; // Preflight handled
  }

  // Apply CORS for actual requests
  if (!applyCORS(req, res)) {
    return; // CORS check failed (403 already sent)
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let pb;
  try {
    const stripe = getStripe();
    pb = await getPocketBase();

    // Validate PocketBase authentication token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - missing or invalid token' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const tokenPayload = decodePocketBaseToken(token);

    if (!tokenPayload) {
      return res.status(401).json({ error: 'Unauthorized - invalid token format' });
    }

    const authenticatedUserId =
      tokenPayload?.recordId ||
      tokenPayload?.id ||
      tokenPayload?.sub ||
      null;

    if (!authenticatedUserId) {
      return res.status(401).json({ error: 'Unauthorized - invalid token payload' });
    }

    pb.authStore.save(token, null);

    const { userId, plan, successUrl, cancelUrl, skipTrial } = req.body;

    // Verify authenticated user matches requested userId
    if (authenticatedUserId !== userId) {
      return res.status(403).json({ error: 'Forbidden - cannot create checkout for another user' });
    }

    if (!userId || !plan || !successUrl || !cancelUrl) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate token by making an API call (this will fail with 401 if token is invalid)
    let user;
    try {
      user = await pb.collection('users').getOne(authenticatedUserId);
    } catch (error) {
      return res.status(401).json({ error: 'Unauthorized - invalid or expired token' });
    }

    // Authenticate with PocketBase as admin
    await pb.admins.authWithPassword(
      process.env.POCKETBASE_ADMIN_EMAIL,
      process.env.POCKETBASE_ADMIN_PASSWORD
    );

    // User data already fetched during token validation (variable 'user' from line 87)

    // Check if user already has a Stripe customer ID
    let customerId;
    const existingSub = await pb.collection('subscriptions')
      .getFirstListItem(`userId="${userId}"`)
      .catch(() => null);

    if (existingSub?.stripeCustomerId) {
      customerId = existingSub.stripeCustomerId;
    } else {
      // Create new Stripe customer
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          pocketbase_user_id: userId
        }
      });
      customerId = customer.id;
    }

    // Determine price ID based on plan
    const normalizedPlan = plan === 'annual' ? 'annual' : 'monthly';
    const priceId = resolvePriceId(normalizedPlan);

    const subscriptionData = {
      metadata: {
        pocketbase_user_id: userId
      }
    };

    if (!skipTrial) {
      subscriptionData.trial_period_days = 7;
    }

    // Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_collection: 'always',
      allow_promotion_codes: true,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      subscription_data: subscriptionData,
      metadata: {
        pocketbase_user_id: userId,
        plan: plan
      }
    });

    const payload = {
      sessionId: session.id,
      url: session.url
    };
    logSuccessSampled('stripe_checkout_ok', { request_id: requestId, plan: normalizedPlan });
    return res.status(200).json(payload);

  } catch (error) {
    log('error', 'stripe_checkout_error', { request_id: requestId, message: error?.message });
    return res.status(500).json({
      error: 'Failed to create checkout session',
      details: error.message
    });
  } finally {
    if (pb) {
      pb.authStore.clear();
    }
    const durationMs = Date.now() - startTime;
    log('debug', 'stripe_checkout_duration', { request_id: requestId, duration_ms: durationMs });
  }
}
