import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log, randomUUID, logSuccessSampled } from '../../logger.js';

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
    pb = await getPocketBase();

    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    await pb.admins.authWithPassword(
      process.env.POCKETBASE_ADMIN_EMAIL,
      process.env.POCKETBASE_ADMIN_PASSWORD
    );

    const normalized = email.trim().toLowerCase();

    await pb.collection('users')
      .getFirstListItem(`email="${normalized}"`);

    return res.status(200).json({ success: true });
  } catch (error) {
    if (error?.status === 404) {
      log('info', 'check_email_not_found', { request_id: requestId });
      return res.status(200).json({ success: false });
    }
    log('error', 'check_email_error', { request_id: requestId, message: error?.message });
    return res.status(500).json({ error: 'Failed to check email' });
  } finally {
    if (pb) {
      pb.authStore.clear();
    }
    const durationMs = Date.now() - startTime;
    logSuccessSampled('check_email_ok', { request_id: requestId, duration_ms: durationMs });
  }
}
