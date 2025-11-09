import Stripe from 'stripe';

const TEST_FLAG = (process.env.USE_STRIPE_TEST_MODE || '').toLowerCase() === 'true';

let cachedStripe;
let cachedStripeKey;

function resolveStripeSecretKey() {
  const testKey = process.env.STRIPE_SECRET_KEY_TEST;
  const liveKey = process.env.STRIPE_SECRET_KEY;

  if (TEST_FLAG) {
    if (testKey) return testKey;
    if (liveKey) return liveKey;
  }

  if (liveKey) return liveKey;

  throw new Error('Stripe secret key is not configured');
}

export function isStripeTestMode() {
  return TEST_FLAG;
}

export function getStripe() {
  const secretKey = resolveStripeSecretKey();
  if (!cachedStripe || cachedStripeKey !== secretKey) {
    cachedStripe = new Stripe(secretKey);
    cachedStripeKey = secretKey;
  }
  return cachedStripe;
}

function lookupEnv(name) {
  return process.env[name];
}

function resolvePriceEnvName(plan, useTest) {
  const suffix = plan === 'annual' ? 'ANNUAL' : 'MONTHLY';
  return useTest ? `STRIPE_PRICE_ID_${suffix}_TEST` : `STRIPE_PRICE_ID_${suffix}`;
}

export function resolvePriceId(plan) {
  const useTest = isStripeTestMode();
  const normalizedPlan = plan === 'annual' ? 'annual' : 'monthly';

  const preferredName = resolvePriceEnvName(normalizedPlan, useTest);
  const fallbackName = resolvePriceEnvName(normalizedPlan, false);

  const priceId = lookupEnv(preferredName) || lookupEnv(fallbackName);

  if (!priceId) {
    throw new Error(`Stripe price id not configured for ${normalizedPlan}`);
  }

  return priceId;
}
