let PocketBaseCtor = null;

export async function getPocketBaseCtor() {
  if (!PocketBaseCtor) {
    const mod = await import('pocketbase');
    PocketBaseCtor = mod?.default ?? mod.PocketBase ?? mod;
  }
  return PocketBaseCtor;
}

export function decodePocketBaseToken(token) {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function escapeFilterValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

export async function getScriptRecord(pb, screenplayId, options = {}) {
  if (!screenplayId) {
    return null;
  }

  const { userId = null, ensureUserRecord = false } = options;
  const escapedScriptId = escapeFilterValue(screenplayId);
  const sanitizedUserId = escapeFilterValue(userId);

  if (userId) {
    const userFilter = `screenplayId = "${escapedScriptId}" && userId = "${sanitizedUserId}"`;
    const userRecord = await pb.collection('scripts').getFirstListItem(userFilter).catch(() => null);
    if (userRecord) {
      return userRecord;
    }
  }

  const filter = `screenplayId = "${escapedScriptId}"`;
  const record = await pb.collection('scripts').getFirstListItem(filter).catch(() => null);
  if (record) {
    return record;
  }

  if (ensureUserRecord && userId) {
    try {
      return await pb.collection('scripts').create({
        screenplayId,
        userId,
      });
    } catch (error) {
      return null;
    }
  }

  return null;
}
