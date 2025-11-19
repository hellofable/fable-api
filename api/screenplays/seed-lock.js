import { randomUUID } from 'node:crypto';
import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log } from '../../logger.js';
import { buildRoomName, readScreenplayStatus } from './statusStore.js';
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

function ensureHpConfig() {
  const base = (process.env.HP_HTTP_BASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    throw new Error('hp_not_configured');
  }
  const token = process.env.HP_INTERNAL_TOKEN || '';
  return { base, token };
}

async function requestHpSeedStatus(roomName, config) {
  const url = `${config.base}/sessions/${encodeURIComponent(roomName)}/seed-status`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Internal-Token': config.token,
      },
    });
    if (response.status === 404) {
      return { ok: true, data: { seeded: false, locked: false, epoch: 1 } };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, status: response.status, body };
    }
    const data = await response.json().catch(() => null);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function requestHpSeedProbe(roomName, config, payload) {
  const url = `${config.base}/sessions/${encodeURIComponent(roomName)}/seed-probe`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': config.token,
      },
      body: JSON.stringify(payload || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409) {
      return { ok: false, status: 409, data };
    }
    if (!response.ok) {
      const errorText = data?.error || await response.text().catch(() => '');
      return { ok: false, status: response.status, error: errorText };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
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

    const userId =
      tokenPayload?.recordId ||
      tokenPayload?.id ||
      tokenPayload?.sub ||
      tokenPayload?.userId ||
      null;
    if (!userId) {
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

    let hpConfig;
    try {
      hpConfig = ensureHpConfig();
    } catch (error) {
      log('warn', 'seed_lock_hp_missing', { screenplayId });
      return res.status(503).json({ error: 'hp_unavailable' });
    }

    const roomName = buildRoomName(screenplayId);
    const statusResult = await requestHpSeedStatus(roomName, hpConfig);
    if (!statusResult.ok) {
      log('warn', 'seed_lock_hp_status_error', {
        screenplayId,
        error: statusResult.error ?? statusResult.body,
      });
      return res.status(503).json({ error: 'hp_unavailable' });
    }

    const hpState = statusResult.data || {};
    log('info', 'seed_lock_hp_status', {
      screenplayId,
      seeded: Boolean(hpState.seeded),
      locked: Boolean(hpState.locked),
      epoch: hpState.epoch,
    });
    if (hpState.seeded) {
      log('info', 'seed_lock_hp_denial', {
        screenplayId,
        reason: 'already_seeded',
        epoch: hpState.epoch,
      });
      return res.status(409).json({
        granted: false,
        reason: 'already_seeded',
        epoch: hpState.epoch ?? null,
      });
    }
    if (hpState.locked) {
      log('info', 'seed_lock_hp_denial', {
        screenplayId,
        reason: 'already_locked',
        epoch: hpState.epoch,
      });
      return res.status(409).json({
        granted: false,
        reason: 'already_locked',
        epoch: hpState.epoch ?? null,
      });
    }

    const actorName =
      tokenPayload?.name ||
      tokenPayload?.username ||
      tokenPayload?.email ||
      'Collaborator';
    const probePayload = {
      actor: actorName,
      requestId: randomUUID(),
      reason: 'seed_lock_check',
    };

    const probeResult = await requestHpSeedProbe(roomName, hpConfig, probePayload);
    if (!probeResult.ok) {
      if (probeResult.status === 409) {
        const data = probeResult.data || {};
        log('info', 'seed_lock_hp_probe_denial', {
          screenplayId,
          reason: data.reason || 'seed_locked',
          epoch: data.epoch ?? hpState.epoch ?? null,
        });
        return res.status(409).json({
          granted: false,
          reason: data.reason || 'seed_locked',
          epoch: data.epoch ?? hpState.epoch ?? null,
        });
      }
      log('error', 'seed_lock_probe_error', {
        screenplayId,
        error: probeResult.error,
      });
      return res.status(503).json({ error: 'hp_unavailable' });
    }

    const payload = probeResult.data || {};
    return res.status(200).json({
      granted: true,
      epoch: payload.epoch ?? hpState.epoch ?? null,
      lockExpiresAt: payload.lockExpiresAt ?? null,
    });
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
