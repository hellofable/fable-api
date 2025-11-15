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

export async function getScriptRecord(pb, screenplayId) {
  const filter = `screenplayId = "${escapeFilterValue(screenplayId)}"`;
  return pb.collection('scripts').getFirstListItem(filter).catch(() => null);
}
