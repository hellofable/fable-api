import { applyCORS, handlePreflight } from '../utils/cors.js';
import { log, logSuccessSampled, randomUUID } from '../logger.js';

// Dynamic import for providers to avoid ESM/CJS issues
async function getProviders() {
	const openaiProvider = await import('../lib/providers/openai.js');
	const deepseekProvider = await import('../lib/providers/deepseek.js');
	const geminiProvider = await import('../lib/providers/gemini.js');
	const anthropicProvider = await import('../lib/providers/anthropic.js');
	return { openaiProvider, deepseekProvider, geminiProvider, anthropicProvider };
}

const POCKETBASE_URL =
	process.env.POCKETBASE_URL || 'https://pb.hellofable.com';

let PocketBaseCtor = null;
async function getPocketBaseCtor() {
	if (!PocketBaseCtor) {
		const mod = await import('pocketbase');
		PocketBaseCtor = mod?.default ?? mod.PocketBase ?? mod;
	}
	return PocketBaseCtor;
}

function jsonResponse(res, status, payload) {
	return res.status(status).json(payload);
}

function decodePocketBaseToken(token) {
	try {
		const [, payload] = token.split('.');
		if (!payload) return null;
		const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
		return decoded;
  } catch (error) {
    log('error', 'ai_decode_token_fail', { message: error?.message });
    return null;
  }
}

function normalizeNumber(value, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

// Provider registry will be created inside handler via getProviders()

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
        log('warn', 'ai_wrong_method', { request_id: requestId, method: req.method });
        return jsonResponse(res, 405, { success: false, error: 'Method not allowed' });
    }

	const { systemPrompt, prompt, estimatedTokens = 100, provider = 'openai' } = req.body || {};
	const normalizedEstimate = Math.max(1, normalizeNumber(estimatedTokens, 100));

    if (!prompt || typeof prompt !== 'string') {
        log('error', 'ai_invalid_request', { request_id: requestId, reason: 'missing_prompt' });
        return jsonResponse(res, 400, {
            success: false,
            error: 'Missing or invalid prompt'
        });
    }

	const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
        log('error', 'ai_auth_fail', { request_id: requestId, reason: 'missing_bearer' });
        return jsonResponse(res, 401, {
            success: false,
            error: 'Unauthorized - missing token'
        });
    }

	const pbToken = authHeader.replace('Bearer ', '');
	const tokenPayload = decodePocketBaseToken(pbToken);
	const userId =
		tokenPayload?.recordId ||
		tokenPayload?.id ||
		tokenPayload?.sub ||
		null;

    if (!userId) {
        log('error', 'ai_auth_fail', { request_id: requestId, reason: 'invalid_token' });
        return jsonResponse(res, 401, {
            success: false,
            error: 'Unauthorized - invalid token'
        });
    }

	const PocketBase = await getPocketBaseCtor();
	const pb = new PocketBase(POCKETBASE_URL);
	pb.authStore.save(pbToken, null);

	try {
		const user = await pb.collection('users').getOne(userId);
		const tokensAvailable = normalizeNumber(user?.tokensAvailable);
		const tokensUsed = normalizeNumber(user?.tokensUsed);

		if (tokensAvailable < normalizedEstimate) {
			return jsonResponse(res, 400, {
				success: false,
				error: 'Insufficient tokens',
				tokensAvailable,
				tokensUsed
			});
		}

		// Load providers dynamically and validate provider
        const { openaiProvider, deepseekProvider, geminiProvider, anthropicProvider } = await getProviders();
        const REGISTRY = { openai: openaiProvider, deepseek: deepseekProvider, gemini: geminiProvider, anthropic: anthropicProvider };
        const selectedProvider = REGISTRY[provider] || REGISTRY.openai;
        const providerName = provider in REGISTRY ? provider : 'openai';
        if (provider !== providerName) {
            log('warn', 'ai_unknown_provider', { request_id: requestId, requested: provider, using: providerName });
        }
        log('info', 'ai_provider_selected', { request_id: requestId, provider: providerName });

		// Log prompts being sent to the provider for server-side debugging
        // Avoid logging raw prompt content at info; keep sizes at debug only.
        log('debug', 'ai_prompt_meta', {
            request_id: requestId,
            has_system_prompt: typeof systemPrompt === 'string',
            system_prompt_bytes: typeof systemPrompt === 'string' ? Buffer.byteLength(systemPrompt, 'utf8') : 0,
            prompt_bytes: Buffer.byteLength(prompt || '', 'utf8'),
            estimated_tokens: normalizedEstimate
        });

		// Generate synopsis using selected provider
		const result = await selectedProvider.generateSynopsis({
			systemPrompt,
			prompt,
			maxTokens: 8192,
			temperature: 0.7
		});

		// Server-side log of the response text and basic metadata
        // Provider metadata at info; response content not logged by default
        log('info', 'ai_provider_meta', {
            request_id: requestId,
            model: result?.model,
            provider: result?.provider,
            input_tokens: result?.inputTokens,
            output_tokens: result?.outputTokens,
            total_tokens: result?.totalTokens
        });
        log('debug', 'ai_response_meta', {
            request_id: requestId,
            synopsis_bytes: Buffer.byteLength(result?.synopsis || '', 'utf8')
        });

		// Calculate internal token cost using provider-specific pricing
		const internalTokenCost = selectedProvider.calculateTokenCost(
			result.inputTokens,
			result.outputTokens
		);

        if (internalTokenCost > tokensAvailable) {
            return jsonResponse(res, 400, {
                success: false,
                error: 'Insufficient tokens',
                tokensAvailable,
                tokensUsed
            });
        }

		const nextTokensAvailable = Math.max(
			0,
			tokensAvailable - internalTokenCost
		);
		const nextTokensUsed = tokensUsed + internalTokenCost;

        await pb.collection('users').update(userId, {
            tokensAvailable: nextTokensAvailable,
            tokensUsed: nextTokensUsed
        });

        const durationMs = Date.now() - startTime;
        logSuccessSampled('ai_ok', {
            request_id: requestId,
            provider: result.provider,
            model: result.model,
            duration_ms: durationMs,
            token_cost: internalTokenCost,
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            total_tokens: result.totalTokens
        });

		return jsonResponse(res, 200, {
			success: true,
			response: result.synopsis,
			tokensAvailable: nextTokensAvailable,
			tokensUsed: nextTokensUsed,
			model: result.model,
			provider: result.provider,
			tokenCost: internalTokenCost,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			totalTokens: result.totalTokens,
			// Expose raw provider response for debugging in browser
			rawProviderResponse: result.raw ?? null
		});
    } catch (error) {
        log('error', 'ai_error', { request_id: requestId, message: error?.message, name: error?.name });
        const statusCode = error?.status || 500;
        return jsonResponse(res, statusCode, {
            success: false,
            error: error?.message || 'Internal server error',
            rawProviderResponse: error?.raw ?? null
        });
    } finally {
        pb.authStore.clear();
    }
}
