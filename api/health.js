export default async function handler(req, res) {
  // Health endpoint should be callable by monitors/CLI without CORS headers.
  if (req.method === 'HEAD') {
    return res.status(200).end();
  }
  if (req.method === 'GET') {
    return res
      .status(200)
      .json({ status: 'ok', timestamp: new Date().toISOString() });
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
