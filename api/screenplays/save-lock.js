import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log } from '../../logger.js';
import {
  getPocketBaseCtor,
  decodePocketBaseToken,
  getScriptRecord,
} from './helpers.js';
import { updateCollaboratorIds, readScreenplayStatus } from './statusStore.js';

const LOCK_EXPIRY_MS = 15_000;

function buildStatusFilter(screenplayId) {
  return `screenplayId = "${screenplayId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function resolveUserContext(pb, tokenPayload) {
  const userId = tokenPayload?.recordId || tokenPayload?.id || tokenPayload?.sub || null;
  let userRecord = null;
  if (userId && pb) {
    try {
      userRecord = await pb.collection('users').getOne(userId);
    } catch (error) {
      log('warn', 'save_lock_fetch_user_failed', {
        userId,
        message: error?.message,
      });
    }
  }

  const displayName =
    (userRecord?.name || '').trim() ||
    userRecord?.username ||
    tokenPayload?.name ||
    tokenPayload?.username ||
    tokenPayload?.email ||
    'User';

  return { userId, displayName };
}

async function fetchScreenplayStatus(pb, screenplayId) {
  // Prefer admin-backed read to ensure we get the record even if user lacks direct read
  try {
    return await readScreenplayStatus(screenplayId);
  } catch (error) {
    // Fallback to user-context read
    const filter = buildStatusFilter(screenplayId);
    try {
      return await pb.collection('screenplay_status').getFirstListItem(filter);
    } catch (inner) {
      if (inner?.status === 404) {
        return null;
      }
      throw inner;
    }
  }
}

function isUserCollaborator(statusRecord, userId) {
  if (!statusRecord || !userId) return false;
  const collaboratorIds = Array.isArray(statusRecord.collaboratorsId)
    ? statusRecord.collaboratorsId
    : Array.isArray(statusRecord.collaboratorIds)
      ? statusRecord.collaboratorIds
      : [];
  if (collaboratorIds.includes(userId)) {
    return true;
  }
  const detailedCollaborators = Array.isArray(statusRecord.collaborators)
    ? statusRecord.collaborators
    : [];
  return detailedCollaborators.some((entry) => entry?.id === userId);
}

async function validateGithubToken(githubToken) {
  if (!githubToken) return null;
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return payload?.id ? payload : null;
  } catch (error) {
    return null;
  }
}

async function maybeAddCollaboratorFromToken(statusRecord, userId, githubToken) {
  if (!githubToken || !statusRecord || !statusRecord.screenplayId) {
    return statusRecord;
  }
  const githubUser = await validateGithubToken(githubToken);
  if (!githubUser?.id) {
    return statusRecord;
  }
  const githubId = String(githubUser.id);
  const collaboratorList = Array.isArray(statusRecord.collaborators)
    ? statusRecord.collaborators
    : [];
  const isGithubCollaborator = collaboratorList.some((entry) => {
    const entryId = entry?.githubId ?? entry?.id;
    return entryId && String(entryId) === githubId;
  });
  if (!isGithubCollaborator) {
    return statusRecord;
  }

  const existingIds = Array.isArray(statusRecord.collaboratorIds)
    ? statusRecord.collaboratorIds
    : Array.isArray(statusRecord.collaboratorsId)
      ? statusRecord.collaboratorsId
      : [];
  if (existingIds.includes(userId)) {
    return statusRecord;
  }

  const nextIds = [...existingIds, userId];
  await updateCollaboratorIds(statusRecord.screenplayId, nextIds);
  return {
    ...statusRecord,
    collaboratorIds: nextIds,
  };
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (!applyCORS(req, res)) return;

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
    log('error', 'token_decode_fail', { endpoint: 'save-lock' });
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

    const { userId, displayName } = await resolveUserContext(pb, tokenPayload);
    if (!userId) {
      log('warn', 'save_lock_missing_user_id', { screenplayId });
      return res.status(401).json({ error: 'Invalid user context' });
    }

    let statusRecord = await fetchScreenplayStatus(pb, screenplayId);
    if (!statusRecord) {
      return res.status(404).json({ error: 'Screenplay status not found' });
    }

    // Optional: allow token-based proof to add caller to collaboratorIds before enforcing
    const githubTokenFromBody = req.body?.githubToken || req.body?.github_token || null;
    if (!isUserCollaborator(statusRecord, userId)) {
      statusRecord = await maybeAddCollaboratorFromToken(statusRecord, userId, githubTokenFromBody);
    }

    if (!isUserCollaborator(statusRecord, userId)) {
      log('warn', 'save_lock_not_collaborator', {
        screenplayId,
        userId,
      });
      return res.status(403).json({ error: 'not_collaborator' });
    }

    if (req.method === 'POST') {
      return await handleAcquireLock(pb, statusRecord, userId, displayName, req, res);
    }
    if (req.method === 'DELETE') {
      return await handleReleaseLock(pb, statusRecord, userId, res);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    log('error', 'save_lock_error', { message: error?.message, screenplayId });
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    pb?.authStore?.clear?.();
  }
}

async function handleAcquireLock(pb, statusRecord, userId, displayName, req, res) {
  const { lockType = 'manual' } = req.body || {};

  const now = new Date();
  const currentLock = statusRecord.saveLock;

  if (currentLock && new Date(currentLock.lockExpiry) > now) {
    log('info', 'save_lock_conflict', {
      screenplayId: statusRecord.screenplayId,
      requestedBy: userId,
      heldBy: currentLock.userId,
    });
    return res.status(409).json({
      success: false,
      error: 'lock_conflict',
      lockedBy: currentLock.userName,
      lockExpiry: currentLock.lockExpiry,
      message: 'Another user is currently saving',
    });
  }

  const expiry = new Date(now.getTime() + LOCK_EXPIRY_MS);
  const newLock = {
    userId,
    userName: displayName,
    lockedAt: now.toISOString(),
    lockType,
    lockExpiry: expiry.toISOString(),
  };

  await pb.collection('screenplay_status').update(statusRecord.id, {
    saveLock: newLock,
  });

  log('info', 'save_lock_acquired', {
    screenplayId: statusRecord.screenplayId,
    userId,
    lockType,
  });

  return res.status(200).json({
    success: true,
    lockExpiry: newLock.lockExpiry,
  });
}

async function handleReleaseLock(pb, statusRecord, userId, res) {
  const currentLock = statusRecord.saveLock;

  if (!currentLock) {
    return res.status(200).json({ success: true });
  }

  if (currentLock.userId !== userId) {
    log('warn', 'save_lock_release_not_owner', {
      screenplayId: statusRecord.screenplayId,
      requestedBy: userId,
      ownedBy: currentLock.userId,
    });
    return res.status(400).json({
      error: 'not_lock_owner',
      message: 'Cannot release lock owned by another user',
    });
  }

  await pb.collection('screenplay_status').update(statusRecord.id, {
    saveLock: null,
  });

  log('info', 'save_lock_released', {
    screenplayId: statusRecord.screenplayId,
    userId,
  });

  return res.status(200).json({ success: true });
}
