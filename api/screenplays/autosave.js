import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log } from '../../logger.js';
import { updateScreenplayMetadata } from './statusStore.js';
import { getPocketBaseCtor, decodePocketBaseToken, getScriptRecord } from './helpers.js';

const VALID_INTERVALS = ['none', '5', '10', '20', '30'];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (!applyCORS(req, res)) return;

  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = req.query?.id || req.params?.id;
  const screenplayId = String(id ?? '').trim();
  if (!screenplayId) {
    return res.status(400).json({ error: 'screenplayId is required' });
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization bearer token' });
  }

  const token = authHeader.replace('Bearer ', '').trim();
  const tokenPayload = decodePocketBaseToken(token);
  if (!tokenPayload) {
    log('error', 'token_decode_fail', { endpoint: 'autosave' });
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  const { interval } = req.body || {};
  if (!interval || !VALID_INTERVALS.includes(interval)) {
    return res.status(400).json({
      error: 'Invalid interval. Must be one of: none, 5, 10, 20, 30',
    });
  }

  try {
    const PocketBase = await getPocketBaseCtor();
    const pb = new PocketBase(process.env.POCKETBASE_URL);
    pb.authStore.save(token, null);

    const scriptRecord = await getScriptRecord(pb, screenplayId);
    if (!scriptRecord) {
      return res.status(404).json({ error: 'Screenplay not found' });
    }

    const autosaveValue = interval === 'none' ? null : parseInt(interval, 10);
    await updateScreenplayMetadata(screenplayId, {
      autosaveInterval: autosaveValue,
      autosaveIntervalUpdatedAt: new Date().toISOString(),
    });

    log('info', 'autosave_interval_updated', { screenplayId, interval: autosaveValue });

    return res.status(200).json({
      screenplayId,
      autosaveInterval: autosaveValue,
      message: 'Autosave interval updated successfully',
    });
  } catch (error) {
    log('error', 'autosave_update_error', { message: error?.message, screenplayId });
    return res.status(500).json({ error: 'Failed to update autosave interval' });
  }
}
