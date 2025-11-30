import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log } from '../../logger.js';
import { decodePocketBaseToken } from './helpers.js';
import {
  readScreenplayStatus,
  updateCollaboratorIds,
} from './statusStore.js';

async function validateGitHubToken(githubToken) {
  if (!githubToken) {
    const err = new Error('GitHub token is required');
    err.status = 400;
    throw err;
  }

  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    const err = new Error(
      response.status === 401
        ? 'Invalid or expired GitHub token'
        : `GitHub API error: ${response.status}`
    );
    err.status = response.status;
    throw err;
  }

  return response.json();
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (!applyCORS(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const screenplayId = String(req.params?.id ?? req.query?.id ?? '').trim();
  if (!screenplayId) {
    return res.status(400).json({ error: 'screenplayId is required' });
  }

  const authHeader = String(req.headers?.authorization ?? '');
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization bearer token' });
  }

  const pbToken = authHeader.replace('Bearer ', '').trim();
  const tokenPayload = decodePocketBaseToken(pbToken);
  if (!tokenPayload) {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  const pbUserId =
    tokenPayload?.recordId ||
    tokenPayload?.id ||
    tokenPayload?.sub ||
    tokenPayload?.userId ||
    null;
  if (!pbUserId) {
    return res.status(401).json({ error: 'Could not determine user ID' });
  }

  const { githubToken } = req.body || {};
  if (!githubToken) {
    return res.status(400).json({ error: 'GitHub token is required' });
  }

  try {
    const githubUser = await validateGitHubToken(githubToken);
    const githubId = String(githubUser.id ?? '').trim();
    if (!githubId) {
      return res.status(401).json({ error: 'Invalid GitHub token' });
    }

    const statusRecord = await readScreenplayStatus(screenplayId);
    const collaborators = Array.isArray(statusRecord?.collaborators)
      ? statusRecord.collaborators
      : [];

    const isCollaborator = collaborators.some(
      (c) => String(c?.id ?? c?.githubId ?? '').trim() === githubId
    );
    if (!isCollaborator) {
      log('warn', 'validate_collaborator_not_found', {
        screenplayId,
        githubId,
        githubLogin: githubUser?.login,
      });
      return res.status(403).json({
        error: 'You are not a collaborator on this repository',
        githubId,
        githubLogin: githubUser?.login,
      });
    }

    const existingIds = Array.isArray(statusRecord?.collaboratorIds)
      ? statusRecord.collaboratorIds
      : [];
    const nextIds = existingIds.includes(pbUserId)
      ? existingIds
      : [...existingIds, pbUserId];

    const updated = await updateCollaboratorIds(screenplayId, nextIds);

    return res.status(200).json({
      success: true,
      validated: true,
      collaboratorIds: updated?.collaboratorIds ?? nextIds,
      githubUser: {
        id: githubUser.id,
        login: githubUser.login,
        avatar_url: githubUser.avatar_url,
        name: githubUser.name,
      },
      pbUserId,
    });
  } catch (error) {
    const status = error?.status || 500;
    const message =
      error?.message ||
      (status === 401
        ? 'Invalid or expired GitHub token'
        : 'Failed to validate collaborator');

    log('error', 'validate_collaborator_failed', {
      screenplayId,
      status,
      message,
    });

    return res.status(status).json({ error: message });
  }
}
