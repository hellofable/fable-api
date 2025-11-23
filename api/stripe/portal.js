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

function decodePocketBaseToken(token) {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (error) {
    log('error', 'portal_decode_token_fail', { message: error?.message });
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

    const { userId, returnUrl } = req.body;

    // Verify authenticated user matches requested userId
    if (authenticatedUserId !== userId) {
      return res.status(403).json({ error: 'Forbidden - cannot access portal for another user' });
    }

    // Validate token by making an API call (this will fail with 401 if token is invalid)
    let user;
    try {
      user = await pb.collection('users').getOne(authenticatedUserId);
    } catch (error) {
      return res.status(401).json({ error: 'Unauthorized - invalid or expired token' });
    }

    // Now authenticate as admin to fetch subscription data
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
