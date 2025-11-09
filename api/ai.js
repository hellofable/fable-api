import { applyCORS, handlePreflight } from '../utils/cors.js';

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
		console.error('Failed to decode PocketBase token', error);
		return null;
	}
}

function normalizeNumber(value, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

// Provider registry will be created inside handler via getProviders()

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
		return jsonResponse(res, 405, { success: false, error: 'Method not allowed' });
	}

	const { systemPrompt, prompt, estimatedTokens = 100, provider = 'openai' } = req.body || {};
	const normalizedEstimate = Math.max(1, normalizeNumber(estimatedTokens, 100));

	if (!prompt || typeof prompt !== 'string') {
		return jsonResponse(res, 400, {
			success: false,
			error: 'Missing or invalid prompt'
		});
	}

	const authHeader = req.headers.authorization || '';
	if (!authHeader.startsWith('Bearer ')) {
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
			console.warn(`[AI] Unknown provider "${provider}", falling back to openai`);
		}

		console.log(`[AI] Using provider: ${providerName}`);

		// Log prompts being sent to the provider for server-side debugging
		try {
			console.log('[AI] System prompt:', typeof systemPrompt === 'string' ? systemPrompt : '');
			console.log('[AI] User prompt:', typeof prompt === 'string' ? prompt : '');
		} catch (_) {
			// ignore logging errors
		}

		// Generate synopsis using selected provider
		const result = await selectedProvider.generateSynopsis({
			systemPrompt,
			prompt,
			maxTokens: 8192,
			temperature: 0.7
		});

		// Server-side log of the response text and basic metadata
		try {
			console.log('[AI] Provider response meta:', {
				model: result?.model,
				provider: result?.provider,
				inputTokens: result?.inputTokens,
				outputTokens: result?.outputTokens,
				totalTokens: result?.totalTokens
			});
			console.log('[AI] Provider response text:', result?.synopsis || '');
		} catch (_) {
			// ignore logging errors
		}

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
		console.error('AI endpoint error:', error);
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
