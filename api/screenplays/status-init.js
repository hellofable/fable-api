import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log } from '../../logger.js';
import { decodePocketBaseToken } from './helpers.js';
import { updateLatestCommitSha } from './statusStore.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (!applyCORS(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = req.params?.id ?? req.query?.id;
  const screenplayId = String(id ?? '').trim();
  if (!screenplayId) {
    return res.status(400).json({ error: 'screenplayId is required' });
  }

  const { fountainSha } = req.body || {};
  if (!fountainSha || typeof fountainSha !== 'string') {
    return res.status(400).json({ error: 'fountainSha is required' });
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization bearer token' });
  }

  const token = authHeader.replace('Bearer ', '').trim();
  const tokenPayload = decodePocketBaseToken(token);
  if (!tokenPayload) {
    log('error', 'status_init_token_decode_fail', { screenplayId });
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  try {
    log('info', 'status_init_request', {
      screenplayId,
      method: req.method,
      hasToken: Boolean(token),
    });

    await updateLatestCommitSha(screenplayId, fountainSha);

    log('info', 'status_init_seeded_sha', {
      screenplayId,
      fountainSha,
    });

    return res.status(200).json({
      screenplayId,
      latestRestoredCommitSha: fountainSha,
    });
  } catch (error) {
    log('error', 'status_init_error', {
      screenplayId,
      message: error?.message,
    });
    return res
      .status(500)
      .json({ error: error?.message || 'Failed to initialize screenplay status' });
  } finally {
  }
}
