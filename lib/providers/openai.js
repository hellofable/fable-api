import { log } from '../../logger.js';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function usesMaxCompletionTokens(model) {
  try {
    return /^gpt-5/i.test(String(model || ''));
  } catch (_) {
    return false;
  }
}

let CachedOpenAI = null;
async function getOpenAIClient() {
  if (!CachedOpenAI) {
    const mod = await import('openai');
    CachedOpenAI = mod?.default ?? mod.OpenAI ?? mod;
  }
  return CachedOpenAI;
}

export async function generateSynopsis({ systemPrompt, prompt, maxTokens = 150, temperature = 0.7 }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const OpenAIClient = await getOpenAIClient();
  const openai = new OpenAIClient({ apiKey: process.env.OPENAI_API_KEY });

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

  // Avoid logging full messages; keep metadata at debug
  try { log('debug', 'openai_request', { model: OPENAI_MODEL, has_system: Boolean(messages?.[0]?.content), prompt_bytes: Buffer.byteLength(messages?.[1]?.content || '', 'utf8') }); } catch {}

  let synopsis = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let rawResponse = null;

  if (usesMaxCompletionTokens(OPENAI_MODEL)) {
    // GPT-5: use Responses API with messages-style input and explicit reasoning/text config
    const sysGuard = `${messages[0].content}\nRespond only with the synopsis text. Do not include analysis or reasoning.`;
    const resp = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: 'system', content: sysGuard },
        { role: 'user', content: messages[1].content }
      ],
      max_output_tokens: Math.max(2000, maxTokens),
      text: { verbosity: 'low' },
      tool_choice: 'none'
    });
    rawResponse = resp;

    // Try several shapes to extract text
    function extractSynopsisFromResponses(r) {
      if (!r) return '';
      if (typeof r.output_text === 'string' && r.output_text.trim()) {
        return r.output_text.trim();
      }
      const parts = [];
      const items = Array.isArray(r.output) ? r.output : [];
      for (const item of items) {
        const content = Array.isArray(item?.content) ? item.content : [];
        for (const c of content) {
          // Newer shape: { type: 'output_text', text: { value: '...' } }
          if (c?.type === 'output_text') {
            if (typeof c.text === 'string' && c.text.trim()) parts.push(c.text.trim());
            else if (typeof c.text?.value === 'string' && c.text.value.trim()) parts.push(c.text.value.trim());
          } else if (typeof c?.text === 'string' && c.text.trim()) {
            parts.push(c.text.trim());
          }
        }
      }
      return parts.join(' ').trim();
    }
    synopsis = extractSynopsisFromResponses(resp);

    inputTokens = resp?.usage?.input_tokens || resp?.usage?.prompt_tokens || 0;
    outputTokens = resp?.usage?.output_tokens || resp?.usage?.completion_tokens || 0;
    totalTokens = resp?.usage?.total_tokens || (inputTokens + outputTokens);
  } else {
    // Other models: Chat Completions
    const basePayload = {
      model: OPENAI_MODEL,
      messages
    };

    if (typeof temperature === 'number') {
      basePayload.temperature = temperature;
    }
    basePayload.max_tokens = maxTokens;

    const completion = await openai.chat.completions.create(basePayload);
    rawResponse = completion;
    synopsis = completion?.choices?.[0]?.message?.content?.trim() || '';
    inputTokens = completion?.usage?.prompt_tokens || 0;
    outputTokens = completion?.usage?.completion_tokens || 0;
    totalTokens = completion?.usage?.total_tokens || (inputTokens + outputTokens);
  }

  if (!synopsis) {
    // Fallback: try a small chat model to get text if GPT-5 responded with reasoning only
    try {
      const fallbackModel = process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini';
      const completion = await openai.chat.completions.create({
        model: fallbackModel,
        messages,
        max_tokens: 150,
        temperature
      });
      rawResponse = rawResponse || completion;
      synopsis = completion?.choices?.[0]?.message?.content?.trim() || '';
      inputTokens = completion?.usage?.prompt_tokens || 0;
      outputTokens = completion?.usage?.completion_tokens || 0;
      totalTokens = completion?.usage?.total_tokens || (inputTokens + outputTokens);
    } catch (fallbackErr) {
      log('error', 'openai_fallback_fail', { message: fallbackErr?.message });
    }
  }

  if (!synopsis) {
    log('error', 'openai_empty_synopsis_after_fallback');
    const err = new Error('OpenAI response did not contain synopsis text');
    err.raw = rawResponse;
    throw err;
  }

  return {
    synopsis,
    inputTokens,
    outputTokens,
    totalTokens,
    model: OPENAI_MODEL,
    provider: 'openai',
    raw: rawResponse
  };
}

export function calculateTokenCost(inputTokens, outputTokens) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);

  // gpt-4o-mini pricing: $0.15/M input, $0.60/M output
  const inputCostPerToken = 0.15 / 1_000_000;
  const outputCostPerToken = 0.60 / 1_000_000;
  const internalTokenValue = 0.0001;

  const totalCost = (input * inputCostPerToken) + (output * outputCostPerToken);
  const internalTokens = totalCost / internalTokenValue;

  return Math.max(1, Math.ceil(internalTokens));
}
