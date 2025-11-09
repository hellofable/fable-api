import { getStripe } from '../../lib/stripe-config.js';
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

    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error('Portal error:', error);
    return res.status(500).json({ error: error.message });
  } finally {
    if (pb) {
      pb.authStore.clear();
    }
  }
}
