import PocketBase from 'pocketbase';

const STATUS_COLLECTION = 'screenplay_status';

let adminClient = null;

function escapeFilterValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

async function getAdminClient() {
  if (adminClient && adminClient.authStore?.isValid) {
    return adminClient;
  }

  const baseUrl = process.env.POCKETBASE_URL;
  const email = process.env.POCKETBASE_ADMIN_EMAIL;
  const password = process.env.POCKETBASE_ADMIN_PASSWORD;

  if (!baseUrl || !email || !password) {
    throw new Error('PocketBase admin credentials are not configured.');
  }

  adminClient = new PocketBase(baseUrl);
  adminClient.autoCancellation?.(false);
  await adminClient.admins.authWithPassword(email, password);
  return adminClient;
}

export function buildRoomName(screenplayId) {
  const raw = String(screenplayId ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw ? `fable-screenplay-${raw}` : 'fable-screenplay';
}

async function getStatusRecord(screenplayId) {
  if (!screenplayId) return null;
  const pb = await getAdminClient();
  try {
    return await pb
      .collection(STATUS_COLLECTION)
      .getFirstListItem(
        `screenplayId = "${escapeFilterValue(screenplayId)}"`,
        { requestKey: undefined },
      );
  } catch (error) {
    if (error?.status === 404) {
      return null;
    }
    throw error;
  }
}

async function ensureStatusRecord(screenplayId) {
  let record = await getStatusRecord(screenplayId);
  if (record) return record;
  const pb = await getAdminClient();
  const now = new Date().toISOString();
    record = await pb.collection(STATUS_COLLECTION).create({
      screenplayId,
      hp_restore_blocked: false,
    hp_restore_blocked_at: null,
    hp_restore_blocked_by: null,
    latestRestoredCommitSha: null,
    latestRestoredCommitSetAt: null,
      autosaveInterval: 0,
      autosaveIntervalUpdatedAt: now,
      collaborators: [],
      collaboratorsUpdatedAt: null,
      pendingRestoreSha: null,
      restoresUpdatedAt: null,
      restoreError: null,
      collaboratorIds: null,
    seedLock: null,
    });
    return record;
  }

export async function readScreenplayStatus(screenplayId) {
  const record = await getStatusRecord(screenplayId);
  if (!record) {
    return {
      screenplayId,
      hp_restore_blocked: false,
      hp_restore_blocked_at: null,
      hp_restore_blocked_by: null,
      latestRestoredCommitSha: null,
      latestRestoredCommitSetAt: null,
      autosaveInterval: 0,
      autosaveIntervalUpdatedAt: null,
      collaborators: [],
      collaboratorsUpdatedAt: null,
      pendingRestoreSha: null,
      restoresUpdatedAt: null,
      restoreError: null,
      collaboratorIds: null,
      seedLock: null,
    };
  }
  return record;
}

async function applyStatusUpdate(screenplayId, patch) {
  const record = await ensureStatusRecord(screenplayId);
  const pb = await getAdminClient();
  return pb.collection(STATUS_COLLECTION).update(record.id, patch);
}

export async function updateLatestCommitSha(screenplayId, sha, setAt = null) {
  const now = new Date().toISOString();
  return applyStatusUpdate(screenplayId, {
    latestCommitSha: sha || null,
    latestRestoredCommitSha: sha || null,
    latestRestoredCommitSetAt: sha ? setAt || now : null,
  });
}

export async function setScreenplayLock(screenplayId, lockPayload) {
  return applyStatusUpdate(screenplayId, lockPayload);
}

export async function clearScreenplayLock(screenplayId) {
  return applyStatusUpdate(screenplayId, {
    hp_restore_blocked: false,
    hp_restore_blocked_at: null,
    hp_restore_blocked_by: null,
    latestRestoredCommitSha: null,
    latestRestoredCommitSetAt: null,
    pendingRestoreSha: null,
    restoresUpdatedAt: null,
    restoreError: null,
  });
}

export async function updateScreenplayMetadata(screenplayId, patch) {
  return applyStatusUpdate(screenplayId, patch);
}

export async function updateCollaborators(screenplayId, collaborators, collaboratorIds = null) {
  const ids = collaboratorIds ?? buildCollaboratorIds(collaborators);
  return applyStatusUpdate(screenplayId, {
    collaborators: collaborators ?? [],
    collaboratorsUpdatedAt: new Date().toISOString(),
    collaboratorIds: ids,
  });
}

function buildCollaboratorIds(collaborators = []) {
  const ids = Array.isArray(collaborators)
    ? collaborators
        .map((entry) => (entry && typeof entry.id === 'string' ? entry.id.trim() : ''))
        .filter((value) => !!value)
    : [];
  return ids.length ? ids : null;
}

export async function updateCollaboratorIds(screenplayId, collaboratorIds) {
  const ids = Array.isArray(collaboratorIds) && collaboratorIds.length ? collaboratorIds : null;
  return applyStatusUpdate(screenplayId, {
    collaboratorIds: ids,
    collaboratorsUpdatedAt: new Date().toISOString(),
  });
}

export async function findAllUsersByGithubId(githubId) {
  if (!githubId) return [];
  const pb = await getAdminClient();
  try {
    const users = await pb.collection('users').getFullList({
      filter: `githubUserIds ?~ ${escapeFilterValue(githubId)}`,
    });
    return Array.isArray(users) ? users : [];
  } catch (error) {
    throw error;
  }
}
