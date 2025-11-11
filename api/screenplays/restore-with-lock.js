import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log } from '../../logger.js';
import {
  setScreenplayLock,
  readScreenplayStatus,
  buildRoomName,
  updateScreenplayMetadata,
} from './statusStore.js';

const GITHUB_API_ROOT = 'https://api.github.com';
const SCREENPLAY_FILE =
  process.env.SCREENPLAY_FILE ||
  process.env.SCREENPLAY_FILENAME ||
  'screenplay.fountain';

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
    log('error', 'restore_lock_decode_fail', { message: error?.message });
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

async function destroyHpSessions(roomName, payload) {
  const base = process.env.HP_HTTP_BASE_URL;
  if (!base) return null;
  const response = await fetch(`${base}/sessions/${encodeURIComponent(roomName)}/destroy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': process.env.HP_INTERNAL_TOKEN || ''
    },
    body: JSON.stringify(payload || {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HP destroy failed (${response.status}): ${text}`);
  }
  return response.json().catch(() => null);
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

const RESTORE_SHA_POLL_INTERVAL_MS = Number(
  process.env.RESTORE_SHA_POLL_INTERVAL_MS || 10000,
);
const RESTORE_SHA_MAX_ATTEMPTS = Number(
  process.env.RESTORE_SHA_MAX_ATTEMPTS || 6,
);
const shaCleanupJobs = new Map();

function clearScheduledShaJob(key) {
  const job = shaCleanupJobs.get(key);
  if (!job) return;
  if (job.timeoutId) {
    clearTimeout(job.timeoutId);
  }
  shaCleanupJobs.delete(key);
}

function scheduleRestoreShaCleanup({
  screenplayId,
  repoOwner,
  repoName,
  filePath,
  commitSha,
  githubToken,
}) {
  if (!screenplayId || !repoOwner || !repoName || !filePath || !commitSha || !githubToken) {
    return;
  }

  clearScheduledShaJob(screenplayId);
  const job = { attempts: 0, timeoutId: null };
  shaCleanupJobs.set(screenplayId, job);

  const attemptClear = async () => {
    const currentJob = shaCleanupJobs.get(screenplayId);
    if (!currentJob) return;
    try {
      const headFile = await getCurrentFileMetadata(
        repoOwner,
        repoName,
        filePath,
        githubToken,
      );
      if (headFile?.sha === commitSha) {
        await updateScreenplayMetadata(screenplayId, {
          latestRestoredCommitSha: null,
          latestRestoredCommitSetAt: null,
        });
        log('info', 'restore_sha_synced', { screenplayId, commitSha });
        clearScheduledShaJob(screenplayId);
        return;
      }
    } catch (error) {
      log('warn', 'restore_sha_poll_error', {
        screenplayId,
        message: error?.message,
      });
    }

    currentJob.attempts += 1;
    if (currentJob.attempts >= RESTORE_SHA_MAX_ATTEMPTS) {
      try {
        await updateScreenplayMetadata(screenplayId, {
          latestRestoredCommitSha: null,
          latestRestoredCommitSetAt: null,
        });
      } catch (clearError) {
        log('warn', 'restore_sha_timeout_clear_fail', {
          screenplayId,
          message: clearError?.message,
        });
      }
      log('warn', 'restore_sha_poll_timeout', { screenplayId, commitSha });
      clearScheduledShaJob(screenplayId);
      return;
    }

    currentJob.timeoutId = setTimeout(() => {
      attemptClear().catch((error) => {
        log('warn', 'restore_sha_poll_unhandled', {
          screenplayId,
          message: error?.message,
        });
        clearScheduledShaJob(screenplayId);
      });
    }, RESTORE_SHA_POLL_INTERVAL_MS);
  };

  attemptClear().catch((error) => {
    log('warn', 'restore_sha_initial_poll_fail', {
      screenplayId,
      message: error?.message,
    });
    clearScheduledShaJob(screenplayId);
  });
}

function encodedPath(path) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function githubFetch(path, token, options = {}) {
  const response = await fetch(`${GITHUB_API_ROOT}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Fable-Restore-Service',
      ...(options.headers || {}),
    },
  });
  return response;
}

async function getFileContentAtRef(owner, repo, filePath, ref, token) {
  const response = await githubFetch(
    `/repos/${owner}/${repo}/contents/${encodedPath(filePath)}?ref=${encodeURIComponent(ref)}`,
    token,
    { method: 'GET' },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to load file at revision (${response.status}): ${text}`);
  }
  const payload = await response.json();
  if (!payload?.content) {
    throw new Error('GitHub did not return file content for the selected revision.');
  }
  return Buffer.from(payload.content, 'base64').toString('utf8');
}

async function getCurrentFileMetadata(owner, repo, filePath, token) {
  const response = await githubFetch(
    `/repos/${owner}/${repo}/contents/${encodedPath(filePath)}`,
    token,
    { method: 'GET' },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to load current screenplay content (${response.status}): ${text}`);
  }
  return response.json();
}

async function updateScreenplayFile(owner, repo, filePath, content, sha, message, token) {
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha,
  };
  const response = await githubFetch(
    `/repos/${owner}/${repo}/contents/${encodedPath(filePath)}`,
    token,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to update screenplay content (${response.status}): ${text}`);
  }
  return response.json();
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (!applyCORS(req, res)) return;
  if (req.method !== 'POST') {
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

  const {
    revisionSha,
    repoOwner,
    repoName,
    githubToken,
    screenplayFile = SCREENPLAY_FILE,
  } = req.body || {};

  if (!revisionSha || !repoOwner || !repoName || !githubToken) {
    return res.status(400).json({
      error: 'revisionSha, repoOwner, repoName, and githubToken are required',
    });
  }

  let pb;
  let scriptRecord = null;
  const now = new Date().toISOString();
  const userName =
    tokenPayload?.name || tokenPayload?.username || tokenPayload?.email || 'Collaborator';
  const blockedBy = {
    userId: tokenPayload?.recordId || tokenPayload?.id || null,
    displayName: userName,
  };

  try {
    const PocketBase = await getPocketBaseCtor();
    pb = new PocketBase(process.env.POCKETBASE_URL);
    pb.authStore.save(token, null);

    scriptRecord = await getScriptRecord(pb, screenplayId);
    if (!scriptRecord) {
      return res.status(404).json({ error: 'Screenplay not found' });
    }

    const statusRecord = await readScreenplayStatus(screenplayId);
    if (statusRecord?.hp_restore_blocked) {
      return res.status(409).json({
        error: 'Restore already in progress',
        blockedAt: statusRecord?.hp_restore_blocked_at,
        blockedBy: statusRecord?.hp_restore_blocked_by,
      });
    }

    await setScreenplayLock(screenplayId, {
      hp_restore_blocked: true,
      hp_restore_blocked_at: now,
      hp_restore_blocked_by: blockedBy,
    });

    const roomName = buildRoomName(screenplayId);

    await destroyHpSessions(roomName, {
      actor: blockedBy.displayName,
      reason: 'restore',
    });

    let commitResult = null;
    try {
      const targetContent = await getFileContentAtRef(
        repoOwner,
        repoName,
        screenplayFile,
        revisionSha,
        githubToken,
      );
      const headFile = await getCurrentFileMetadata(
        repoOwner,
        repoName,
        screenplayFile,
        githubToken,
      );
      const shortSha = String(revisionSha).slice(0, 7);
      const message = `Restore screenplay to ${shortSha}`;
      commitResult = await updateScreenplayFile(
        repoOwner,
        repoName,
        screenplayFile,
        targetContent,
        headFile?.sha,
        message,
        githubToken,
      );
    } catch (error) {
      log('error', 'restore_github_error', {
        screenplayId,
        message: error?.message,
      });
      throw error;
    }

    const latestCommitSha = commitResult?.commit?.sha || null;
    const restoreCompletedAt = new Date().toISOString();

    await updateScreenplayMetadata(screenplayId, {
      hp_restore_blocked: false,
      hp_restore_blocked_at: null,
      hp_restore_blocked_by: null,
      lastRestoredAt: restoreCompletedAt,
      lastRestoredBy: blockedBy.userId,
      restoredFrom: revisionSha,
      latestRestoredCommitSha: latestCommitSha,
      latestRestoredCommitSetAt: latestCommitSha ? restoreCompletedAt : null,
    });

    if (latestCommitSha) {
      scheduleRestoreShaCleanup({
        screenplayId,
        repoOwner,
        repoName,
        filePath: screenplayFile,
        commitSha: latestCommitSha,
        githubToken,
      });
    }

    await unblockHpSessions(roomName, {
      actor: blockedBy.displayName,
      reason: 'restore_complete',
    });

    return res.status(200).json({
      status: 'ok',
      screenplayId,
      commit: commitResult?.commit ?? null,
      latestRestoredCommitSha: latestCommitSha,
    });
  } catch (error) {
    log('error', 'restore_lock_error', { message: error?.message, screenplayId });
    return res.status(500).json({ error: error?.message || 'Failed to restore revision' });
  } finally {
    pb?.authStore?.clear?.();
  }
}
