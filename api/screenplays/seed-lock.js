import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log } from '../../logger.js';
import { getPocketBaseCtor, decodePocketBaseToken, getScriptRecord } from './helpers.js';
import { readScreenplayStatus } from './statusStore.js';

const LOCK_TTL_MS = Number(process.env.SEED_LOCK_TTL_MS || 15000);
const seedLocks = new Map();

function clearLock(screenplayId, reason = 'timeout') {
  const entry = seedLocks.get(screenplayId);
  if (!entry) return;
  clearTimeout(entry.timer);
  seedLocks.delete(screenplayId);
  log('info', 'seed_lock_cleared', {
    screenplayId,
    lockedBy: entry.lockedBy,
    reason,
  });
}

function scheduleLockTimeout(screenplayId) {
  const entry = seedLocks.get(screenplayId);
  if (!entry) return;
  entry.timer = setTimeout(() => {
    clearLock(screenplayId);
  }, LOCK_TTL_MS);
}

function getLockStatus(screenplayId) {
  const entry = seedLocks.get(screenplayId);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt <= now) {
    clearLock(screenplayId);
    return null;
  }
  return entry;
}

async function resolveUserContext(pb, tokenPayload) {
  const userId =
    tokenPayload?.recordId ||
    tokenPayload?.id ||
    tokenPayload?.sub ||
    tokenPayload?.userId ||
    null;
  let userRecord = null;
  if (userId && pb) {
    try {
      userRecord = await pb.collection('users').getOne(userId);
    } catch (error) {
      log('warn', 'seed_lock_user_fetch_failed', {
        userId,
        message: error?.message,
      });
    }
  }
  return { userId, userRecord };
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (!applyCORS(req, res)) return;

  if (!['POST', 'DELETE'].includes(req.method)) {
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
    log('error', 'seed_lock_token_decode_failed', { screenplayId });
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

    const { userId } = await resolveUserContext(pb, tokenPayload);
    if (!userId) {
      log('warn', 'seed_lock_missing_user_id', { screenplayId });
      return res.status(401).json({ error: 'Invalid user context' });
    }

    const statusRecord = await readScreenplayStatus(screenplayId);
    if (!statusRecord) {
      return res.status(404).json({ error: 'Screenplay status missing' });
    }

    if (req.method === 'POST') {
      const lock = getLockStatus(screenplayId);
      if (lock) {
        return res.status(409).json({
          granted: false,
          reason: 'locked',
          lockedBy: lock.lockedBy,
        });
      }

      const now = Date.now();
      seedLocks.set(screenplayId, {
        locked: true,
        lockedBy: userId,
        lockedAt: new Date(now).toISOString(),
        expiresAt: now + LOCK_TTL_MS,
        timer: null,
      });
      scheduleLockTimeout(screenplayId);

      log('info', 'seed_lock_acquired', {
        screenplayId,
        userId,
      });
      return res.status(200).json({ granted: true });
    }

    if (req.method === 'DELETE') {
      const lock = getLockStatus(screenplayId);
      if (!lock) {
        return res.status(200).json({ cleared: true });
      }
      if (lock.lockedBy !== userId) {
        log('warn', 'seed_lock_release_forbidden', {
          screenplayId,
          owner: lock.lockedBy,
          requester: userId,
        });
        return res.status(403).json({ error: 'not_lock_owner' });
      }

      clearLock(screenplayId, 'release');
      log('info', 'seed_lock_released', {
        screenplayId,
        userId,
      });
      return res.status(200).json({ cleared: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    log('error', 'seed_lock_handler_error', {
      screenplayId,
      message: error?.message,
    });
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    pb?.authStore?.clear?.();
  }
}
