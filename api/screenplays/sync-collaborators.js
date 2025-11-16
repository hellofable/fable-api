import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log } from '../../logger.js';
import { decodePocketBaseToken } from './helpers.js';
import {
  readScreenplayStatus,
  updateCollaborators,
  findUserByGithubId,
} from './statusStore.js';

const GITHUB_PER_PAGE = 100;
const GITHUB_MAX_PAGES = 10;
const USER_AGENT = 'Fable-Sync-Collaborators';

async function fetchGitHubCollaborators({ repoOwner, repoName, githubToken }) {
  const collaborators = [];
  let page = 1;

  while (page <= GITHUB_MAX_PAGES) {
    const url = new URL(`https://api.github.com/repos/${encodeURIComponent(
      repoOwner,
    )}/${encodeURIComponent(repoName)}/collaborators`);
    url.searchParams.set('per_page', String(GITHUB_PER_PAGE));
    url.searchParams.set('page', String(page));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
      },
    });

    if (!response.ok) {
      const err = new Error('Failed to load GitHub collaborators');
      err.status = response.status;
      err.body = await response.text();
      throw err;
    }

    const data = await response.json().catch(() => null);
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    collaborators.push(...data);
    if (data.length < GITHUB_PER_PAGE) {
      break;
    }
    page += 1;
  }

  return collaborators;
}

function mapExistingCollaborators(existing = []) {
  const lookup = new Map();
  for (const collaborator of existing) {
    if (collaborator?.id) {
      lookup.set(collaborator.id, collaborator);
    }
  }
  return lookup;
}

function getCollaboratorName(userRecord, fallback) {
  return (
    userRecord?.name ||
    userRecord?.username ||
    fallback ||
    'Collaborator'
  );
}

async function buildCollaboratorsPayload(screenplayId, githubMembers) {
  const existingStatus = await readScreenplayStatus(screenplayId);
  const existingMap = mapExistingCollaborators(existingStatus?.collaborators);
  const results = [];
  const seen = new Set();
  const now = new Date().toISOString();

  for (const member of githubMembers ?? []) {
    if (!member || typeof member.id === 'undefined') continue;
    const userRecord = await findUserByGithubId(member.id);
    if (!userRecord) continue;
    if (seen.has(userRecord.id)) continue;
    seen.add(userRecord.id);

    const previousEntry = existingMap.get(userRecord.id);
    results.push({
      id: userRecord.id,
      name: getCollaboratorName(userRecord, member.login),
      githubUsername: member.login ?? previousEntry?.githubUsername ?? null,
      joinedAt: previousEntry?.joinedAt || now,
    });
  }

  return results;
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (!applyCORS(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const screenplayId = String(req.params?.id ?? req.query?.id ?? '').trim();
  if (!screenplayId) {
    return res.status(400).json({ error: 'screenplayId is required' });
  }

  const { repoOwner, repoName, githubToken } = req.body || {};
  if (!repoOwner || !repoName || !githubToken) {
    return res
      .status(400)
      .json({ error: 'repoOwner, repoName, and githubToken are required' });
  }

  const authHeader = String(req.headers?.authorization ?? '');
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization bearer token' });
  }

  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }

  const tokenPayload = decodePocketBaseToken(token);
  if (!tokenPayload) {
    log('error', 'sync_collaborators_token_decode_fail', { screenplayId });
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  try {
    const githubMembers = await fetchGitHubCollaborators({
      repoOwner,
      repoName,
      githubToken,
    });

    const collaborators = await buildCollaboratorsPayload(
      screenplayId,
      githubMembers,
    );

    await updateCollaborators(screenplayId, collaborators);

    const userId =
      tokenPayload?.user?.id ?? tokenPayload?.sub ?? tokenPayload?.aud ?? null;
    log('info', 'collaborators_synced', {
      screenplayId,
      repo: `${repoOwner}/${repoName}`,
      workers: collaborators.length,
      user: userId,
    });

    return res.status(200).json({ screenplayId, collaborators });
  } catch (error) {
    log('error', 'sync_collaborators_failed', {
      message: error?.message,
      status: error?.status,
      screenplayId,
      repo: `${repoOwner}/${repoName}`,
    });

    if (error?.status === 401 || error?.status === 403) {
      return res.status(403).json({ error: 'Unable to fetch collaborators from GitHub' });
    }
    if (error?.status === 404) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    return res.status(500).json({ error: 'Failed to sync collaborators' });
  }
}
