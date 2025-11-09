import { log } from '../../logger.js';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

let CachedOpenAI = null;
async function getOpenAIClient() {
  if (!CachedOpenAI) {
    const mod = await import('openai');
    CachedOpenAI = mod?.default ?? mod.OpenAI ?? mod;
  }
  return CachedOpenAI;
}

export async function generateSynopsis({ systemPrompt, prompt, maxTokens = 150, temperature = 0.7 }) {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is not configured');
  }

  const OpenAIClient = await getOpenAIClient();
  // DeepSeek uses OpenAI SDK but with custom base URL
  const client = new OpenAIClient({
    apiKey: process.env.DEEPSEEK_API_KEY,
    // DeepSeek's OpenAI-compatible endpoint expects versioned baseURL
    baseURL: 'https://api.deepseek.com/v1'
  });

  const messages = [
    {
      role: 'system',
      content:
        systemPrompt?.trim() ||
        'You write screenplay beat sheets, not prose. State ONLY what happens in simple factual terms. DO NOT describe visuals, cinematography, atmosphere, or camera work. Focus on character actions and story beats.'
    },
    {
      role: 'user',
      content: prompt.trim()
    }
  ];

  try { log('debug', 'deepseek_request', { model: DEEPSEEK_MODEL, has_system: Boolean(messages?.[0]?.content), prompt_bytes: Buffer.byteLength(messages?.[1]?.content || '', 'utf8') }); } catch {}

  const completion = await client.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages,
    max_tokens: maxTokens,
    temperature
  });

  const choice = completion?.choices?.[0] || {};
  const synopsis = (choice?.message?.content || '').trim();
  if (!synopsis) {
    const finish = choice?.finish_reason ?? 'unknown';
    throw new Error(
      `DeepSeek returned no message.content (finish_reason=${finish}). If using deepseek-reasoner, switch to DEEPSEEK_MODEL=deepseek-chat to avoid reasoning output.`
    );
  }

  const inputTokens = completion?.usage?.prompt_tokens || 0;
  const outputTokens = completion?.usage?.completion_tokens || 0;
  const totalTokens = completion?.usage?.total_tokens || (inputTokens + outputTokens);

  return {
    synopsis,
    inputTokens,
    outputTokens,
    totalTokens,
    model: DEEPSEEK_MODEL,
    provider: 'deepseek'
  };
}

export function calculateTokenCost(inputTokens, outputTokens) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);

  // DeepSeek pricing: $0.14/M input, $0.28/M output
  const inputCostPerToken = 0.14 / 1_000_000;
  const outputCostPerToken = 0.28 / 1_000_000;
  const internalTokenValue = 0.0001;

  const totalCost = (input * inputCostPerToken) + (output * outputCostPerToken);
  const internalTokens = totalCost / internalTokenValue;

  return Math.max(1, Math.ceil(internalTokens));
}
