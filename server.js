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

// JSON for non-webhook routes
app.use('/api', express.json({ limit: '2mb' }));
app.use('/api', cors());

// Health
app.get('/api/health', (req, res) => health(req, res));
app.head('/api/health', (req, res) => health(req, res));

// Core endpoints
app.post('/api/github-oauth', (req, res) => githubOauth(req, res));
app.post('/api/ai', (req, res) => ai(req, res));
app.post('/api/users/checkEmail', (req, res) => checkEmail(req, res));
app.post('/api/voice/create', (req, res) => voiceCreate(req, res));

// Stripe webhook requires raw body for signature verification
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => stripeWebhook(req, res)
);

// Stripe helpers
app.post('/api/stripe/create-checkout', (req, res) => stripeCreateCheckout(req, res));
app.post('/api/stripe/createCheckoutSessionNew', (req, res) => stripeCreateCheckoutNew(req, res));
app.post('/api/stripe/portal', (req, res) => stripePortal(req, res));

// Fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`[fable-api] listening on :${PORT}`);
});

