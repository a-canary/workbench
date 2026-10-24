/**
 * Minimal OpenAI-compatible chat client. Defaults route through arc-llm-proxy
 * (arc-proxy/planning alias: a local model, with a second local host as
 * failover) — the proxy enforces slots, audit logging, and rate/balance
 * tracking. Endpoint/model overridable via env for emergency bypass:
 *   BENCH_LLM_ENDPOINT   full base URL (e.g. http://localhost:1234/v1)
 *   BENCH_LLM_MODEL      bare model id (e.g. Bonsai-27B-Q1_0.gguf)
 * Bypass is the deliberate carve-out for emergencies/ad-hoc; the default
 * MUST go through the proxy so consumers don't learn direct endpoints.
 */

const ENDPOINT = process.env.BENCH_LLM_ENDPOINT || 'http://127.0.0.1:8091/v1';
const MODEL = process.env.BENCH_LLM_MODEL || 'planning';

/**
 * One chat completion. Returns { content, usage: {input, output, total} }.
 * Reasoning models may put the answer in reasoning_content when content is
 * empty — fall back to it.
 */
export async function chat(messages, { maxTokens = 2048, temperature = 0, timeoutMs = 180000 } = {}) {
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  const content = (msg.content || '').trim();
  const answer = content || (msg.reasoning_content || '').trim();
  const usage = data.usage || {};
  return {
    content: answer,
    usage: {
      input: usage.prompt_tokens || 0,
      output: usage.completion_tokens || 0,
      total: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
  };
}

export const llmModelId = MODEL;
