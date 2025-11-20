import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log } from '../../logger.js';
import {
  readScreenplayStatus,
  updateScreenplayMetadata,
} from './statusStore.js';
import {
  getPocketBaseCtor,
  decodePocketBaseToken,
  getScriptRecord,
} from './helpers.js';

function isUserCollaborator(statusRecord, userId) {
  if (!statusRecord || !userId) return false;
  const ids = Array.isArray(statusRecord.collaboratorIds)
    ? statusRecord.collaboratorIds
    : [];
  if (ids.includes(userId)) {
    return true;
  }
  const detailed = Array.isArray(statusRecord.collaborators)
    ? statusRecord.collaborators
    : [];
  return detailed.some((entry) => entry?.id === userId);
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
    if (!isUserCollaborator(statusRecord, userId)) {
      log('warn', 'seed_lock_not_collaborator', {
        screenplayId,
        userId,
      });
      return res.status(403).json({ error: 'not_collaborator' });
    }

    if (req.method === 'POST') {
      if (statusRecord.seededAt) {
        return res.status(409).json({
          granted: false,
          reason: 'already_seeded',
        });
      }
      if (statusRecord.seedLocked) {
        return res.status(409).json({
          granted: false,
          reason: 'locked',
          lockedBy: statusRecord.seedLockedBy || null,
        });
      }

      await updateScreenplayMetadata(screenplayId, {
        seedLocked: true,
        seedLockedBy: userId,
        seedLockedAt: new Date().toISOString(),
        seededAt: null,
      });

      log('info', 'seed_lock_acquired', {
        screenplayId,
        userId,
      });
      return res.status(200).json({ granted: true });
    }

    if (req.method === 'DELETE') {
      if (!statusRecord.seedLocked) {
        return res.status(200).json({ cleared: true });
      }
      if (statusRecord.seedLockedBy && statusRecord.seedLockedBy !== userId) {
        log('warn', 'seed_lock_release_forbidden', {
          screenplayId,
          owner: statusRecord.seedLockedBy,
          requester: userId,
        });
        return res.status(403).json({ error: 'not_lock_owner' });
      }

      await updateScreenplayMetadata(screenplayId, {
        seedLocked: false,
        seedLockedBy: null,
        seedLockedAt: null,
        seededAt: new Date().toISOString(),
      });

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
