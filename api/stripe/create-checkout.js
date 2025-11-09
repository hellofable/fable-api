import { getStripe, resolvePriceId } from '../../lib/stripe-config.js';
import { applyCORS, handlePreflight } from '../../utils/cors.js';

let cachedPb;
async function getPocketBase() {
  if (!cachedPb) {
    const PocketBaseModule = await import('pocketbase');
    const PocketBase = PocketBaseModule.default || PocketBaseModule;
    cachedPb = new PocketBase(process.env.POCKETBASE_URL);
  }
  return cachedPb;
}

export default async function handler(req, res) {
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

    const { userId, plan, successUrl, cancelUrl, skipTrial } = req.body;

    if (!userId || !plan || !successUrl || !cancelUrl) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Authenticate with PocketBase as admin
    await pb.admins.authWithPassword(
      process.env.POCKETBASE_ADMIN_EMAIL,
      process.env.POCKETBASE_ADMIN_PASSWORD
    );

    // Get user data
    const user = await pb.collection('users').getOne(userId);

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

    return res.status(200).json({
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('Stripe checkout error:', error);
    return res.status(500).json({
      error: 'Failed to create checkout session',
      details: error.message
    });
  } finally {
    if (pb) {
      pb.authStore.clear();
    }
  }
}
