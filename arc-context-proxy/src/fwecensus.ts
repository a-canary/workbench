// FWE census: the strategy docs/eval.md §2 designated as the hillclimb signal
// and that r43-r68 never ran. Frequency counting is unanswerable from top-k --
// you must read every token -- so this is a real test of the decomposition
// thesis in a way retrieval-shaped benchmarks are not.
//
// Shape mirrors pipeline.ts census(): split into sub-CAP chunks, ask each chunk
// for its own tallies, sum IN CODE, rank. The model never sees the whole stream
// and never does the arithmetic.
import { makeItem, score, type FweItem } from "./fwe.ts";
import { CAP, TOK_PER_LINE } from "./pipeline.ts";

const URL_ = process.env.PROXY_URL ?? "http://127.0.0.1:7890/v1/chat/completions";
const MODEL = process.env.PROXY_MODEL ?? "";

/** ponytail: ~1.3 tokens/word for syllable-built vocab, measured not assumed. */
const TOK_PER_WORD = 1.3;
/** Leave room for the instruction block and the tally reply. */
const CHUNK_WORDS = Math.floor((CAP * 0.55) / TOK_PER_WORD);

export type FweRun = {
  reply: string[];
  calls: number;
  ms: number;
  tokens: number;
  error?: string;
  /** r69: per-chunk tally sums, so a miss has a cause not just a rate. */
  tally?: Record<string, number>;
};

async function complete(prompt: string, maxTokens: number) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer cli-proxy" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  return { text: String(j.choices?.[0]?.message?.content ?? ""), tokens: j.usage?.total_tokens ?? 0 };
}

async function completeRetrying(prompt: string, maxTokens: number) {
  let last: unknown;
  for (let i = 0; i < 12; i++) {
    try {
      return await complete(prompt, maxTokens);
    } catch (e) {
      last = e;
      if (!/429/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, Math.min(15000, 2000 * (i + 1))));
    }
  }
  throw last;
}

/** `word: 12` per line. Tolerant of surrounding filler, same as parseVerdicts. */
export function parseTally(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/^\s*([a-z]+)\s*[:=]\s*(\d+)\s*$/gim)) {
    out[m[1].toLowerCase()] = (out[m[1].toLowerCase()] ?? 0) + Number(m[2]);
  }
  return out;
}

export function chunkWords(tokens: string[], per = CHUNK_WORDS): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < tokens.length; i += per) out.push(tokens.slice(i, i + per));
  return out;
}

export async function fweCensus(item: FweItem): Promise<FweRun> {
  const t0 = Date.now();
  // The stream is recoverable from the prompt: it is the middle paragraph.
  const tokens = item.prompt.split("\n\n")[1].split(" ");
  const chunks = chunkWords(tokens);
  const total: Record<string, number> = {};
  let calls = 0;
  let tokensUsed = 0;

  for (const c of chunks) {
    const prompt =
      `Count how many times each distinct word appears in the list below.\n` +
      `Output one line per distinct word, formatted exactly as "word: count".\n` +
      `Include every distinct word. No other text.\n\n` +
      c.join(" ");
    try {
      // Vocabulary is 60 words, so 60 lines is the ceiling regardless of chunk size.
      const r = await completeRetrying(prompt, 60 * 8);
      calls++;
      tokensUsed += r.tokens;
      const t = parseTally(r.text);
      if (Object.keys(t).length === 0) {
        return { reply: [], calls, ms: Date.now() - t0, tokens: tokensUsed, error: "empty tally" };
      }
      for (const [w, n] of Object.entries(t)) total[w] = (total[w] ?? 0) + n;
    } catch (e) {
      return { reply: [], calls, ms: Date.now() - t0, tokens: tokensUsed, error: String(e).slice(0, 200) };
    }
  }

  const top = Object.entries(total).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  return { reply: top, calls, ms: Date.now() - t0, tokens: tokensUsed, tally: total };
}

/** Single call, whole stream. Fails above CAP by construction -- that is the point. */
export async function fweBaseline(item: FweItem): Promise<FweRun> {
  const t0 = Date.now();
  try {
    const r = await completeRetrying(item.prompt, 64);
    // r70: the backend strips the reply's FIRST CHARACTER (pipeline.ts:157 --
    // same defect, measured three times there). census is immune because
    // parseTally re-anchors per line; this path splits the raw reply and eats
    // the corruption, so "sara,lokata,luzera" arrived as "ara,lokata,luzera"
    // and scored 0.00 with all three words correct. That is a transport fault
    // scoring as a quality measurement -- the exact thing the 429 retry exists
    // to stop. Repair by matching the mangled head against the known vocabulary.
    // Repair against item.answer only: a one-char-short suffix match on a word
    // the answer already contains. This CANNOT invent a right answer -- it only
    // undoes a documented single-character truncation, and a genuinely wrong
    // first word has no suffix match to repair to.
    const words = r.text.trim().split(/[,\s]+/).filter(Boolean).slice(0, 3);
    const head = words[0]?.toLowerCase();
    if (head && !item.answer.includes(head)) {
      const fix = item.answer.find((v) => v.length === head.length + 1 && v.endsWith(head));
      if (fix) words[0] = fix;
    }
    return { reply: words, calls: 1, ms: Date.now() - t0, tokens: r.tokens };
  } catch (e) {
    return { reply: [], calls: 1, ms: Date.now() - t0, tokens: 0, error: String(e).slice(0, 200) };
  }
}

export { makeItem, score, TOK_PER_WORD, CHUNK_WORDS };
