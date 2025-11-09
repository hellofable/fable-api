const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1';

function extractTextFromCandidates(json) {
  try {
    const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
    for (const cand of candidates) {
      // Common v1 shape: content: { role, parts: [{ text }] }
      const partsA = cand?.content?.parts;
      if (Array.isArray(partsA)) {
        const texts = partsA
          .map((p) => (typeof p?.text === 'string' ? p.text.trim() : ''))
          .filter(Boolean);
        if (texts.length) return texts.join(' ').trim();
      }
      // Sometimes content is an array of parts directly
      const partsB = Array.isArray(cand?.content) ? cand.content : [];
      if (Array.isArray(partsB)) {
        const texts = partsB
          .map((p) => (typeof p?.text === 'string' ? p.text.trim() : ''))
          .filter(Boolean);
        if (texts.length) return texts.join(' ').trim();
      }
      // Fallback: direct text field on candidate
      if (typeof cand?.text === 'string' && cand.text.trim()) return cand.text.trim();
    }
    return '';
  } catch (_) {
    return '';
  }
}

async function callGenerateContent({ apiKey, systemPrompt, prompt, maxTokens, temperature, model }) {
  const modelName = model || GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/${encodeURIComponent(GEMINI_API_VERSION)}/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const userParts = [];
  if (systemPrompt && String(systemPrompt).trim()) {
    userParts.push({ text: String(systemPrompt).trim() });
  }
  userParts.push({ text: String(prompt || '').trim() });

  const body = {
    contents: [
      {
        role: 'user',
        parts: userParts
      }
    ],
    generationConfig: {
      temperature: typeof temperature === 'number' ? temperature : 0.3,
      maxOutputTokens: Math.max(128, Math.min(2048, typeof maxTokens === 'number' ? maxTokens : 256)),
      candidateCount: 1
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' }
    ]
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return resp;
}

async function callResponsesGenerate({ apiKey, systemPrompt, prompt, maxTokens, temperature }) {
  const url = `https://generativelanguage.googleapis.com/${encodeURIComponent(GEMINI_API_VERSION)}/responses:generate?key=${encodeURIComponent(apiKey)}`;

  const body = {
    model: GEMINI_MODEL,
    system_instruction: systemPrompt && String(systemPrompt).trim()
      ? { role: 'system', parts: [{ text: String(systemPrompt).trim() }] }
      : undefined,
    contents: [
      {
        role: 'user',
        parts: [{ text: String(prompt || '').trim() }]
      }
    ],
    generationConfig: {
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      maxOutputTokens: typeof maxTokens === 'number' ? maxTokens : 150
    }
  };
  // prune undefined
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return resp;
}

export async function generateSynopsis({ systemPrompt, prompt, maxTokens = 256, temperature = 0.3 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  // First try generateContent
  console.log('[Gemini Provider] Request:', {
    model: GEMINI_MODEL,
    version: GEMINI_API_VERSION,
    hasSystem: Boolean(systemPrompt && String(systemPrompt).trim()),
    promptLength: (String(prompt || '').trim()).length,
    maxTokens,
    temperature
  });
  let resp = await callGenerateContent({ apiKey, systemPrompt, prompt, maxTokens, temperature, model: GEMINI_MODEL });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`Gemini API error: ${resp.status} ${resp.statusText}`);
    err.raw = text;
    throw err;
  }

  const json = await resp.json();
  let synopsis = extractTextFromCandidates(json);

  // No model fallback: if empty, surface error with raw payload for inspection

  if (!synopsis) {
    const err = new Error('Gemini response did not contain synopsis text');
    err.raw = json;
    throw err;
  }

  const inputTokens = json?.usageMetadata?.promptTokenCount || 0;
  const outputTokens = json?.usageMetadata?.candidatesTokenCount || 0;
  const totalTokens = json?.usageMetadata?.totalTokenCount || (inputTokens + outputTokens);

  return {
    synopsis,
    inputTokens,
    outputTokens,
    totalTokens,
    model: GEMINI_MODEL,
    provider: 'gemini',
    raw: json
  };
}

export function calculateTokenCost(inputTokens, outputTokens) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);

  // Approximate Gemini 1.5 Flash pricing: $0.075/M input, $0.30/M output
  const inputCostPerToken = 0.075 / 1_000_000;
  const outputCostPerToken = 0.30 / 1_000_000;
  const internalTokenValue = 0.0001;

  const totalCost = (input * inputCostPerToken) + (output * outputCostPerToken);
  const internalTokens = totalCost / internalTokenValue;

  return Math.max(1, Math.ceil(internalTokens));
}

