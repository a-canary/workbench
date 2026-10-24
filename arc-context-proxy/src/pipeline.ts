// Two strategies over the same task, so the census can be measured against the
// thing it claims to beat.
import type { Task } from "./task.ts";

const URL = process.env.PROXY_URL ?? "http://127.0.0.1:7890/v1/chat/completions";
const MODEL = process.env.PROXY_MODEL ?? "";
const CAP = 32768; // window cap — re-measure against whichever backend is live — see docs/eval.md §6
/**
 * Output tokens per verdict line, measured in r50: a 9980-token ceiling emitted
 * ~111 restatement lines before truncating. The r41 restatement roughly doubled
 * line cost from the 60 originally assumed. TOK_PER_LINE carries headroom.
 */
const TOK_PER_LINE = 120;
/** Batch ceiling so a batch never asks for more output than one call can emit. */
const MAX_LINES = 100;

// verdicts: per-unit booleans behind the count, aligned to task.units.
// r58: the count is one sample per seed; these are 80. Optional because
// baseline() has no per-unit stage to report.
export type Run = { reply: string; calls: number; ms: number; tokens: number; error?: string; verdicts?: boolean[] };

/**
 * Prompt+completion tokens for the last call. Terminal-Bench reports cost in
 * dollars beside accuracy, because an accuracy number without its price is
 * unfalsifiable as an engineering claim — see docs/eval.md §7. Tokens are the
 * provider-neutral form of that; dollars are tokens x a rate card.
 * ponytail: a module-level accumulator, not threaded through every signature.
 * Single-threaded harness, one call in flight.
 */
let lastTokens = 0;

async function complete(prompt: string, maxTokens = 2000): Promise<string> {
  const r = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer cli-proxy" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
  const j = JSON.parse(txt);
  lastTokens = j.usage?.total_tokens ?? 0;
  return j.choices?.[0]?.message?.content ?? "";
}

/**
 * Upstream 429s surface through the proxy as HTTP 500 and were scoring as
 * wrong answers, which is a transport fault masquerading as a quality
 * measurement. Retry those specifically; a real error still fails loudly.
 * Measured: a run with 0 transport errors scored 7.2% count error, one with 3
 * scored 63.3% — the 429s were the entire spread, so tolerating them costs
 * more than waiting them out. Saturation observed clearing in ~30s.
 * ponytail: capped linear backoff, not exponential — the queue clears in
 * seconds and exponential would overshoot past the 15-minute run cap.
 */
async function completeRetrying(prompt: string, maxTokens: number, tries = 12): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await complete(prompt, maxTokens);
    } catch (e) {
      if (i >= tries - 1 || !/429/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, Math.min(15000, 2000 * (i + 1))));
    }
  }
}

/** Baseline: whole corpus in one call. Expected to fail past the 32k cap. */
export async function baseline(task: Task): Promise<Run> {
  const t0 = Date.now();
  try {
    const reply = await completeRetrying(task.prompt, 64);
    return { reply, calls: 1, ms: Date.now() - t0, tokens: lastTokens };
  } catch (e) {
    return { reply: "", calls: 1, ms: Date.now() - t0, tokens: lastTokens, error: String(e).slice(0, 200) };
  }
}

/** Pack units into batches that stay under the context cap. */
function batch(units: string[], budgetTokens: number): string[][] {
  // r47: this sized on units[0] alone, so batch width swung 9x on the length of
  // one sampled sentence (seed 1000 -> 1 call, r43 seeds -> 9 calls, same 80
  // units). Correctness was unaffected — every unit is judged either way — but
  // it made per-call cost and latency incomparable across rounds. Max, not
  // first: the estimate has to hold for the longest unit or a batch overflows.
  const longest = units.reduce((m, u) => Math.max(m, u.length), 0);
  const perUnit = Math.ceil((longest / 4) * 1.6); // ~1.56 tok/word, measured
  // r50: batching modelled INPUT tokens only. At 153 units/batch every seed
  // failed with ~111/153 verdicts — the reply was truncated, not the prompt.
  // Each r41 restatement line costs ~90 output tokens (measured: 9980 max_tokens
  // / 111 lines emitted), not the 60 assumed here, and r41 never re-measured it
  // because 80-unit batches never approached the ceiling. Output is the binding
  // constraint past ~110 units, so bound the batch by it too.
  const per = Math.max(1, Math.min(Math.floor(budgetTokens / perUnit), MAX_LINES));
  const out: string[][] = [];
  for (let i = 0; i < units.length; i += per) out.push(units.slice(i, i + per));
  return out;
}

/**
 * Parse "INDEX: restatement -> YES|NO" lines into per-unit verdicts.
 * Not line-anchored: the backend strips the reply's first character, so unit 0
 * arrives mangled ("0>: NO") and an anchored pattern dropped exactly one unit
 * per batch — five rounds of 100% error. The verdict trails a restatement
 * (r41), so anchor on the LAST token of the line, not the token after the index.
 * ponytail: one parser, used by both the retry check and the scorer — two
 * copies of this regex would drift.
 */
function parseVerdicts(reply: string, n: number): Map<number, boolean> {
  const verdicts = new Map<number, boolean>();
  for (const m of reply.matchAll(/(\d+)\s*>?\s*[:.)]([^\n]*?)(YES|NO)\s*$/gim)) {
    const i = Number(m[1]);
    if (i >= 0 && i < n) verdicts.set(i, /yes/i.test(m[3]));
  }
  return verdicts;
}

const countVerdicts = (reply: string, n: number) => parseVerdicts(reply, n).size;

/**
 * Census: classify every unit, then SUM IN CODE.
 * The model never estimates a total — it only ever emits per-unit booleans.
 * This is the difference between this design and map-reduce summarization.
 */
export async function census(task: Task, budgetTokens = 12000): Promise<Run> {
  const t0 = Date.now();
  const batches = batch(task.units, budgetTokens);
  let total = 0;
  const flat: boolean[] = [];
  let calls = 0;
  let tokens = 0;

  /**
   * DeepSeek-V4-Flash requires concurrency 4 — it is a property of how the
   * model is served, not a client-side optimization, so this is the correct
   * configuration rather than a tuning knob. Batches are independent (the
   * census sums verdicts IN CODE), so a worker pool is safe: nothing
   * downstream depends on batch order or on an earlier batch's result.
   * ponytail: fixed-width pool over a shared cursor, not a scheduler.
   */
  const width = Number(process.env.PROXY_CONCURRENCY ?? 4);
  const results: (string | null)[] = new Array(batches.length).fill(null);
  let cursor = 0;
  let failure = "";

  async function worker() {
    for (;;) {
      const idx = cursor++;
      if (idx >= batches.length || failure) return;
      const b = batches[idx];
      const listed = b.map((u, i) => `--- UNIT ${i} ---\n${u}`).join("\n\n");
      const prompt =
        `${listed}\n\n${task.question.replace(/Answer with a single integer and nothing else\./, "")}\n\n` +
        // The backend strips the reply's FIRST CHARACTER — measured three times:
        // "0: NO\n1: NO..." arrives as "": NO\n1: NO...", losing unit 0 entirely.
        // A sacrificial first line absorbs the strip; cheaper than fighting it.
        `First output the line BEGIN, then go through the units IN ORDER.\n` +
        `For EVERY unit output one line:\n` +
        // r41: restating each unit's core problem before its verdict took the
        // diagnostic from 2-4 errors/480 to 0/480. The model always knew these
        // answers (r40: 10/10 in isolation) — it lost them to dilution across a
        // long list. One short phrase per unit, no extra calls. See docs/eval.md.
        // r61: was "the customer's core problem in 3-5 words" — the SURFACE
        // symptom, which on the r52 hard items is exactly the misleading part
        // ("lost premium support" reads as billing; the cause is an org merge).
        // r60 showed the model judges these correctly in isolation and loses
        // them in bulk, so the restatement must carry the deciding fact.
        `INDEX: <what actually went wrong, the ROOT CAUSE, in 3-5 words> -> YES   (or -> NO)\n` +
        `e.g.  0: avatar file size limit -> NO\n` +
        `e.g.  1: admin deleted own seat -> NO\n` +
        `e.g.  2: card wrongly flagged expired -> YES\n` +
        // r69: examples 3-5 REMOVED. Each was authored after reading the
        // previous round's per-phrase miss breakdown, and each restated the
        // answer for the single task.ts item dominating those misses
        // (task.ts:76, :71, :50). That is adaptive overfitting -- the author is
        // the optimizer, each breakdown read is a query against held-out labels,
        // and the degrees of freedom spent are invisible in the reported CI.
        // The r53 isolation protocol returned 10/10 on every one of those items,
        // so the examples supplied an answer the model already had. Examples 0-2
        // predate any breakdown and specify FORMAT plus both polarities: kept.
        `Output BEGIN then exactly ${b.length} lines, one per unit, and nothing else.`;
      try {
        // r48: seed 1000 returned a reply parsing to 0/80 verdicts, having
        // scored 23/23 on the identical prompt minutes earlier at temperature 0.
        // An empty/garbled reply is a transport fault, but it fell through the
        // completeness guard and scored as countErr 1.0 — one bad reply moved a
        // 12-seed mean by 8.3pt. That is the same "transport fault masquerading
        // as a quality measurement" the 429 retry above exists to stop.
        // One retry: enough for provider noise, and a real prompt defect still
        // fails twice and surfaces.
        let reply = await completeRetrying(prompt, TOK_PER_LINE * b.length + 800);
        calls++;
        tokens += lastTokens;
        if (countVerdicts(reply, b.length) < b.length) {
          reply = await completeRetrying(prompt, TOK_PER_LINE * b.length + 800);
          calls++;
          tokens += lastTokens;
        }
        results[idx] = reply;
      } catch (e) {
        calls++;
        tokens += lastTokens;
        failure = String(e).slice(0, 200);
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, batches.length) }, worker));
  if (failure) return { reply: "", calls, ms: Date.now() - t0, tokens, error: failure };

  for (let idx = 0; idx < batches.length; idx++) {
    const b = batches[idx];
    const reply = results[idx] ?? "";
    const verdicts = parseVerdicts(reply, b.length);
    // A short reply means units went unjudged. Scoring it would undercount
    // silently — the exact failure r19 exists to remove.
    if (verdicts.size < b.length) {
      return {
        reply: "",
        calls,
        ms: Date.now() - t0,
        tokens,
        error: `only ${verdicts.size}/${b.length} units judged`,
      };
    }
    // r58: keep the per-unit verdicts, don't just sum them. The count alone is
    // one number per seed; the verdicts behind it are 80 binary judgments per
    // seed. r57 bounded the count-based floor at ~5.4pt because ~30 seeds is
    // all the 15-minute budget buys — but those same 30 calls already contain
    // ~2400 judgments. The evidence was being thrown away at this line.
    for (let i = 0; i < b.length; i++) {
      const v = verdicts.get(i)!;
      flat.push(v);
      if (v) total++;
    }
  }

  // reply is unchanged — every existing round stays comparable.
  return { reply: String(total), calls, ms: Date.now() - t0, tokens, verdicts: flat };
}

// Exported for test: r47 and r50 were both batching defects that shipped
// because nothing exercised these directly. See pipeline.test.ts.
export { CAP, TOK_PER_LINE, MAX_LINES, batch, parseVerdicts };
