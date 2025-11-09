import { getStripe, resolvePriceId } from '../../lib/stripe-config.js';
import { applyCORS, handlePreflight } from '../../utils/cors.js';
import { log, logSuccessSampled, randomUUID } from '../../logger.js';

export default async function handler(req, res) {
  const requestId = randomUUID();
  const startTime = Date.now();
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

  try {
    const {
      email,
      plan,
      successUrl,
      cancelUrl,
      success_url,
      cancel_url
    } = req.body || {};

    const normalizedEmail = email?.trim().toLowerCase();
    const finalSuccessUrl = successUrl || success_url;
    const finalCancelUrl = cancelUrl || cancel_url;

    if (!normalizedEmail || !plan || !finalSuccessUrl || !finalCancelUrl) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const normalizedPlan = plan.toLowerCase();
    const isAnnual = normalizedPlan === 'annual' || normalizedPlan === 'yearly';
    const isMonthly = normalizedPlan === 'monthly';
    if (!isAnnual && !isMonthly) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const stripe = getStripe();

    const existing = await stripe.customers.list({
      email: normalizedEmail,
      limit: 1,
    });

    let customerId;
    if (existing.data.length) {
      customerId = existing.data[0].id;
    } else {
      const customer = await stripe.customers.create({
        email: normalizedEmail,
        metadata: {
          pending_user_email: normalizedEmail,
        },
      });
      customerId = customer.id;
    }

    const planKey = isAnnual ? 'annual' : 'monthly';
    const priceId = resolvePriceId(planKey);

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_collection: 'always',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: finalSuccessUrl,
      cancel_url: finalCancelUrl,
      client_reference_id: normalizedEmail,
      metadata: {
        pending_user_email: normalizedEmail,
        plan: planKey,
        selected_plan: planKey
      },
      subscription_data: {
        trial_period_days: 7,
        metadata: {
          pending_user_email: normalizedEmail,
          plan: planKey,
          selected_plan: planKey
        },
      },
    });

    const payload = {
      sessionId: session.id,
      url: session.url,
    };
    logSuccessSampled('stripe_checkout_public_ok', { request_id: requestId, plan: planKey });
    return res.status(200).json(payload);
  } catch (error) {
    log('error', 'stripe_checkout_public_error', { request_id: requestId, message: error?.message });
    return res.status(500).json({
      error: 'Failed to create checkout session',
      details: error.message,
    });
  } finally {
    const durationMs = Date.now() - startTime;
    log('debug', 'stripe_checkout_public_duration', { request_id: requestId, duration_ms: durationMs });
  }
}
