import { getStripe } from '../../lib/stripe-config.js';
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
    const { userId, returnUrl } = req.body;

    const stripe = getStripe();
    pb = await getPocketBase();

    await pb.admins.authWithPassword(
      process.env.POCKETBASE_ADMIN_EMAIL,
      process.env.POCKETBASE_ADMIN_PASSWORD
    );

    const subscription = await pb.collection('subscriptions')
      .getFirstListItem(`userId="${userId}"`);

    if (!subscription?.stripeCustomerId) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: returnUrl,
    });

    const payload = { url: session.url };
    logSuccessSampled('stripe_portal_ok', { request_id: requestId });
    return res.status(200).json(payload);

  } catch (error) {
    log('error', 'stripe_portal_error', { request_id: requestId, message: error?.message });
    return res.status(500).json({ error: error.message });
  } finally {
    if (pb) {
      pb.authStore.clear();
    }
    const durationMs = Date.now() - startTime;
    log('debug', 'stripe_portal_duration', { request_id: requestId, duration_ms: durationMs });
  }
}
