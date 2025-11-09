import dotenv from 'dotenv';
// Load local dev env when not in production
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: '.env.local' });
}

import express from 'express';
import cors from 'cors';

// Import Vercel-style handlers (default export function(req, res))
import health from './api/health.js';
import githubOauth from './api/github-oauth.js';
import ai from './api/ai.js';
import checkEmail from './api/users/checkEmail.js';
import voiceCreate from './api/voice/create.js';
import stripeWebhook from './api/stripe/webhook.js';
import stripeCreateCheckout from './api/stripe/create-checkout.js';
import stripeCreateCheckoutNew from './api/stripe/createCheckoutSessionNew.js';
import stripePortal from './api/stripe/portal.js';

const app = express();
const PORT = process.env.PORT || 8302;

// CORS for all API routes
app.use('/api', cors());

// IMPORTANT: Do NOT apply express.json() globally before the Stripe webhook.
// Attach JSON parsing per-route so the webhook can receive the raw body.

// Health
app.get('/api/health', (req, res) => health(req, res));
app.head('/api/health', (req, res) => health(req, res));

// Core endpoints
app.post('/api/github-oauth', express.json({ limit: '2mb' }), (req, res) => githubOauth(req, res));
app.post('/api/ai', express.json({ limit: '2mb' }), (req, res) => ai(req, res));
app.post('/api/users/checkEmail', express.json({ limit: '2mb' }), (req, res) => checkEmail(req, res));
app.post('/api/voice/create', express.json({ limit: '2mb' }), (req, res) => voiceCreate(req, res));

// Stripe webhook requires raw body for signature verification
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => stripeWebhook(req, res)
);

// Stripe helpers
app.post('/api/stripe/create-checkout', express.json({ limit: '2mb' }), (req, res) => stripeCreateCheckout(req, res));
app.post('/api/stripe/createCheckoutSessionNew', express.json({ limit: '2mb' }), (req, res) => stripeCreateCheckoutNew(req, res));
app.post('/api/stripe/portal', express.json({ limit: '2mb' }), (req, res) => stripePortal(req, res));

// Optional: respond 405 for HEAD on webhook path for quick checks without touching POST logic
app.head('/api/stripe/webhook', (_req, res) => res.sendStatus(405));

// Fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`[fable-api] listening on :${PORT}`);
});
