import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log } from '../../logger.js';
import { clearScreenplayLock, buildRoomName } from './statusStore.js';

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
    log('error', 'restore_unlock_decode_fail', { message: error?.message });
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

async function unblockHpSessions(roomName, payload) {
  const base = process.env.HP_HTTP_BASE_URL;
  if (!base) return null;
  const response = await fetch(`${base}/sessions/${encodeURIComponent(roomName)}/unblock`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': process.env.HP_INTERNAL_TOKEN || ''
    },
    body: JSON.stringify(payload || {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HP unblock failed (${response.status}): ${text}`);
  }
  return response.json().catch(() => null);
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (!applyCORS(req, res)) return;
  if (req.method !== 'DELETE') {
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

  let pb;
  try {
    const PocketBase = await getPocketBaseCtor();
    pb = new PocketBase(process.env.POCKETBASE_URL);
    pb.authStore.save(token, null);

    const scriptRecord = await getScriptRecord(pb, screenplayId);
    if (!scriptRecord) {
      return res.status(404).json({ error: 'Screenplay not found' });
    }

    await clearScreenplayLock(screenplayId);
    const roomName = buildRoomName(screenplayId);
    await unblockHpSessions(roomName, {
      actor: tokenPayload?.name || tokenPayload?.username || tokenPayload?.email || 'Collaborator',
      reason: 'restore_unlock',
    });

    return res.status(200).json({ status: 'ok', screenplayId });
  } catch (error) {
    log('error', 'restore_unlock_error', { message: error?.message, screenplayId });
    return res.status(500).json({ error: 'Failed to clear restore lock' });
  } finally {
    pb?.authStore?.clear?.();
  }
}
