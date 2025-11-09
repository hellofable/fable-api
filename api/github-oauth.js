import { applyCORS, handlePreflight } from '../utils/cors.js';
import https from 'https';

export default async function handler(req, res) {
    // Handle CORS preflight
    if (handlePreflight(req, res)) {
        return; // Preflight handled
    }

    // Apply CORS for actual requests
    if (!applyCORS(req, res)) {
        return; // CORS check failed (403 already sent)
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { code, codeVerifier, redirectUri } = req.body;

    try {
        const postData = JSON.stringify({
            client_id: process.env.GITHUB_CLIENT_ID,
            client_secret: process.env.GITHUB_CLIENT_SECRET,
            code,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri
        });

        const options = {
            hostname: 'github.com',
            path: '/login/oauth/access_token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': postData.length
            }
        };

        const githubResponse = await new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            });
            req.on('error', reject);
            req.write(postData);
            req.end();
        });

        const data = JSON.parse(githubResponse.body);
        return res.status(githubResponse.status).json(data);
    } catch (error) {
        return res.status(500).json({
            error: 'exchange_failed',
            message: error.message
        });
    }
}