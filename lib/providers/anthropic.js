const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
const ANTHROPIC_API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';

function extractTextFromContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  const parts = [];
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b?.text === 'string' && b.text.trim()) {
      parts.push(b.text.trim());
    }
    // Future: handle tool_result or other block types if needed
  }
  return parts.join(' ').trim();
}

export async function generateSynopsis({ systemPrompt, prompt, maxTokens = 150, temperature = 0.7 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: Math.max(64, Number(maxTokens) || 150),
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    system: (systemPrompt && String(systemPrompt).trim()) || undefined,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: String(prompt || '').trim() }
        ]
      }
    ]
  };

  // Remove undefined keys
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  const resp = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    const err = new Error(`Anthropic API error: ${resp.status} ${resp.statusText}`);
    err.raw = raw;
    throw err;
  }

  const json = await resp.json();
  const synopsis = extractTextFromContent(json?.content);
  if (!synopsis) {
    const err = new Error('Anthropic response did not contain synopsis text');
    err.raw = json;
    throw err;
  }

  const inputTokens = json?.usage?.input_tokens || 0;
  const outputTokens = json?.usage?.output_tokens || 0;
  const totalTokens = inputTokens + outputTokens;

  return {
    synopsis,
    inputTokens,
    outputTokens,
    totalTokens,
    model: ANTHROPIC_MODEL,
    provider: 'anthropic',
    raw: json
  };
}

export function calculateTokenCost(inputTokens, outputTokens) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);

  // Approximate Claude 3.5 Sonnet pricing: $3.00/M input, $15.00/M output
  const inputCostPerToken = 3.00 / 1_000_000;
  const outputCostPerToken = 15.00 / 1_000_000;
  const internalTokenValue = 0.0001; // internal token unit used by app

  const totalCost = (input * inputCostPerToken) + (output * outputCostPerToken);
  const internalTokens = totalCost / internalTokenValue;

  return Math.max(1, Math.ceil(internalTokens));
}

