import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log } from '../../logger.js';
import { readScreenplayStatus, buildRoomName } from './statusStore.js';

let PocketBaseCtor = null;
async function getPocketBaseCtor() {
  if (!PocketBaseCtor) {
    const mod = await import('pocketbase');
    PocketBaseCtor = mod?.default ?? mod.PocketBase ?? mod;
  }
  return PocketBaseCtor;
}

function decodePocketBaseToken(token) {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (error) {
    log('error', 'restore_status_decode_fail', { message: error?.message });
    return null;
  }
}

function escapeFilterValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

async function getScriptRecord(pb, screenplayId) {
  const filter = `screenplayId = "${escapeFilterValue(screenplayId)}"`;
  return pb.collection('scripts').getFirstListItem(filter).catch(() => null);
}

async function fetchHpSessionStatus(roomName) {
  const base = process.env.HP_HTTP_BASE_URL;
  if (!base) return null;
  try {
    const response = await fetch(`${base}/sessions/${encodeURIComponent(roomName)}/status`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': process.env.HP_INTERNAL_TOKEN || ''
      }
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    log('warn', 'hp_status_fetch_fail', { roomName, message: error?.message });
    return null;
  }
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (!applyCORS(req, res)) return;
  if (req.method !== 'GET') {
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
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  try {
    const PocketBase = await getPocketBaseCtor();
    const pb = new PocketBase(process.env.POCKETBASE_URL);
    pb.authStore.save(token, null);

    const scriptRecord = await getScriptRecord(pb, screenplayId);
    if (!scriptRecord) {
      return res.status(404).json({ error: 'Screenplay not found' });
    }

    const statusRecord = await readScreenplayStatus(screenplayId);
    const roomName = buildRoomName(screenplayId);
    const hpStatus = await fetchHpSessionStatus(roomName);
    const activeUsers = Array.isArray(hpStatus?.activeUsers)
      ? hpStatus.activeUsers
      : [];

    return res.status(200).json({
      screenplayId,
      blocked: Boolean(statusRecord?.hp_restore_blocked),
      blockedAt: statusRecord?.hp_restore_blocked_at || null,
      blockedBy: statusRecord?.hp_restore_blocked_by || null,
      latestRestoredCommitSha: statusRecord?.latestRestoredCommitSha || null,
      latestRestoredCommitSetAt: statusRecord?.latestRestoredCommitSetAt || null,
      activeUsers,
    });
  } catch (error) {
    log('error', 'restore_status_error', { message: error?.message, screenplayId });
    return res.status(500).json({ error: 'Failed to load restore status' });
  }
}
