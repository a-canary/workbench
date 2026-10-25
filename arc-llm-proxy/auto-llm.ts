// auto-llm — the classifier→Thompson→attacker loop behind alias "auto-llm".
//
//   1. classify: last user message + "classify-only" suffix → judge combo → task class
//   2. select:   cost-aware Thompson sample over the class's arms
//   3. A:        complete the turn (content HELD BACK until verdict — P2)
//   4. B:        attacker triages EXPLORE turns (2026-09-10 ruling: B off on
//                 exploit; beta rises only on approve-without-edits):
//                 SILENT-APPROVE → deliver as-is
//                 HEAL-TOOL-CALL → deliver with B's validated heal (no beta rise)
//                 RESPOND-BLOCKING-COMMENT → deliver text + doubts; calls ALWAYS delivered, flags become post-hoc notes (trusted-confirmation gated)
//                 STEALTH-DENY-RETRY → discard, exclude arm, resample (≤ maxRetries)
//               L0 deterministic heal (names/args) runs before B — zero LLM cost.
//   gates:     P1 (2026-09-10): deterministic degeneracy gates (empty, leaked
//               tool-call markup, invalid tool calls) run on ALL traffic,
//               exploit included — gate-hit falls back to the explore path.
//   hold-back: P2 (2026-09-10): no live forwarding; verdicts precede delivery.
//               Deny = full redaction (nothing was ever sent), then resample.
//   exploit:   ≤90% of traffic, only when top arm's raw beta > 0.99 — greedy
//              arm, gates only (no B), no reward.
//   pricing:  cost-aware TS (alpha blend); cache-aware since 2026-09-10: an
//              arm whose upstream prefix-cache is hot for the conversation
//              draws at price × cacheFactor (prompt tokens are ~99% of
//              agent-turn cost, so the flat factor ≈ the cached-input discount).
//   rewards:   B verdicts on explore turns only (approve +1; heal/comment/deny
//              never raise beta; upstream errors lower it).
//   telemetry:   one JSONL line per request (logFile) — the weekly cron's input
//
// ponytail: v1 bypasses the switchboard queue/slots — 9router runs its own
// cooldown+queue. Fold into sb accounting if the pool ever needs slot fairness.

import { readFileSync, writeFileSync, appendFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { affinityKeyFromBody } from "./server.ts"; // stable conversation key — same hash the switchboard HOME table uses
import { join } from "node:path";
import { homedir } from "node:os";

/** Upstream leak signatures: models emitting their native tool-call syntax
 *  as turn text instead of structured tool_calls (Qwen <tool_call>, minimax
 *  <minimax:tool_call>, cline <invoke>). Deterministic deny — cheap judges
 *  approve the markup as "a tool call" (2026-09-10: approved turn wedged RRDM). */
export const TOOL_LEAK_RE = /<(?:minimax:)?tool_c|<\/?invoke/;

/** P1: deterministic degeneracy gate, runs on ALL traffic (exploit included)
 *  BEFORE any delivery — with P2 hold-back nothing has reached the client yet,
 *  so a deny fully redacts and the ladder resamples another arm. */
/** Byte size above which an `empty` completion is treated as request-determined
 *  rather than an arm fault. ~400KB of JSON is ~100k tokens; below that an empty
 *  is more likely a sick arm and retrying another family is worth the spend.
 *  Exists because an over-window request makes empties DTERMINISTIC: every retry
 *  re-sends the same 100k+ token prompt and re-pays for it (operator, 2026-09-18:
 *  40 paid upstream sends for 1 usable turn). */
export const EMPTY_FAILFAST_BYTES = 400_000;

export function gateReason(text: string, callCount: number, invalidCalls: number): string | null {
  if (!text.trim() && !callCount) return "empty";
  if (TOOL_LEAK_RE.test(text)) return "leak";
  if (invalidCalls > 0) return "bad-tool-call";
  return null;
}

export const ATTACK_PROMPT = `You are an adversarial reviewer inside an LLM router.
A model produced TURN for TASK. The TURN may contain text and tool calls;
tool calls would be executed by the caller. Tool calls reach you only as
structured TOOL CALLS — tool-call syntax appearing inside the turn TEXT
(<tool_call>, <minimax:tool_call>, <invoke name=…> markup) is leaked template
noise, not a real tool call: rule STEALTH-DENY-RETRY. Review silently — do
not echo the task or turn back.

Ruling ladder — pick exactly one:
- SILENT-APPROVE: the turn is sound (correct, complete, safe). When in doubt
  between approve and anything else, approve.
- HEAL-TOOL-CALL: a tool call has a SMALL mechanical defect (wrong-but-mappable
  argument name, missing required argument derivable from the task, truncated
  or malformed JSON) and the rest of the turn is sound. Emit the complete healed
  tool_calls array in a ` + "```json" + ` fenced block immediately before the ruling line.
  Heal only what is unambiguous — never guess values.
- RESPOND-BLOCKING-COMMENT: material defect the caller must see (factually
  wrong, would fail, misses the task, dangerous action). You may ONLY redact
  tool calls and pose the doubt the caller must answer first; never order the
  caller to stop, halt, or abandon the task. Before the ruling line, write one
  FLAG line per call you redact — calls you do not FLAG pass through
  unmodified — plus at most one short overall warning (under 80 words):
  FLAG <call id verbatim from TOOL CALLS, or #position>: <question the caller must answer before this call runs>
- STEALTH-DENY-RETRY: garbage (incoherent, empty, wrong language, template
  noise) with nothing worth showing — discard; another model retries silently.

End with exactly one final line:
RULING: SILENT-APPROVE
or RULING: HEAL-TOOL-CALL
or RULING: RESPOND-BLOCKING-COMMENT
or RULING: STEALTH-DENY-RETRY

TASK:
{TASK}

TOOLS:
{TOOLS}

TURN:
{TURN}`;

export interface AutoCfg {
  classes: string[];
  unknownClass: string;
  universeTtlMs?: number;   // arms = live gateway models, refreshed on TTL
  armsExclude?: string[];   // regexes; models matching these never arm
  judge: string;          // combo alias used for classify + attack triage (B)
  trustedJudge?: string;  // trusted (reference) judge — paid/limited access, hence sampled: re-grades ~trustRate of ALL turns, exploit included (trustedSample has no explore guard — a graduated arm is exactly the one whose estimate must not freeze, so "even a perfect model gets retested" is a requirement, not a rounding error); paired verdicts judge the cheap-judge POOL, not the turn; zero reward/delivery impact
  judgePool?: string[];   // judge failover chain after the primary (classify + attack; trusted judge stays single-shot fail-safe). glm honors thinking:disabled (25s→1.8s probed 2026-09-11), qwen ignores it — always sent
  trustRate?: number;     // trusted-judge sampling rate (default 0.05)
  backoffMinMs?: number;   // global arm backoff on provider-side failures: first penalty (default 3s)
  backoffCapMs?: number;   // backoff ceiling (default 3 days) — quotas/rate limits recover; never hard-disable
  gateway: string;        // 9router chat-completions URL
  keyFile: string;        // proxy's own gateway key (internal users; externals pass their Bearer through)
  stateFile: string;      // TS priors, JSON
  logFile: string;        // telemetry JSONL
  cooldownMs: number;     // exclude arms that errored within this window
  maxRetries: number;     // explore-denial / error resample budget
  judgeMaxTokens?: number; // judge thinks → needs room (default 500)
  pretrain?: Record<string, Record<string, { a: number; b: number }>>; // merged under state on load
  injectTurnScope?: boolean; // prepend detected class as a system "[turn scope]" hint upstream (off by default)
  correctionRounds?: number; // comment verdicts: redact flagged calls → forward to a second TS generator → re-review, up to N rounds (default 3); review invisible to end user, corrected arms take beta hits
  softFail?: SoftFailCfg;    // next-turn execution-failure feedback: regex over the incoming conversation, downgrade the arm that served the repeated failing call
  pricing?: PriceCfg;      // cost-aware TS; absent = plain TS
}

/** Cost-aware TS pricing, cheapest truth first:
 *  1. real observed $/1M from 9router's usageHistory (paid arms — actual spend)
 *  2. free arms ($0 history) → shadow price: freeFactor × OpenRouter market blend
 *  3. unpriced → median → weight 1 (plain TS). Fail-open everywhere. */
export interface PriceCfg {
  historyDb?: string;         // 9router sqlite (default ~/.9router/db/data.sqlite)
  historyMinTokens?: number; // min ok-tokens before trusting observed price (2000)
  marketUrl?: string;        // OpenRouter public models API, no auth
  marketCache?: string;      // market cache path (default deploy/market-prices.json)
  marketTtlMs?: number;      // cache freshness (24h)
  freeFactor?: number;       // free-arm shadow = factor × market blend (0.3)
  alpha?: number;           // cost sensitivity, weight = (median/price)^alpha (0.5)
  refreshMs?: number;        // refresh interval (1h)
  cacheFactor?: number;      // hot-prefix price multiplier (0.5) — upstream prompt-cache hit
  cacheTtlMs?: number;       // prefix-cache heat expiry (30 min; Anthropic ~5m, Minimax/DeepSeek hours)
}

export type ArmStat = { a: number; b: number };
export type TsState = Record<string, Record<string, ArmStat>>;

// ---------- pure sampling primitives (tested) ----------

function gauss(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Marsaglia–Tsang gamma sample, shape > 0. */
export function gammaSample(shape: number, rng: () => number): number {
  if (shape < 1) return gammaSample(shape + 1, rng) * Math.pow(rng() || 1e-12, 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0, v = 0;
    do { x = gauss(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng() || 1e-12;
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function betaSample(a: number, b: number, rng: () => number): number {
  const ga = gammaSample(a, rng), gb = gammaSample(b, rng);
  return ga / (ga + gb || 1);
}

export interface Pick { model: string; explore: boolean }

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Cost-aware draw weight: (median/price)^alpha clamped [0.25,4] — cheap arms draw higher. */
export function costWeight(price: number | undefined, med: number, alpha: number): number {
  if (!price || !(price > 0) || !(med > 0) || alpha <= 0) return 1;
  return Math.min(4, Math.max(0.25, Math.pow(med / price, alpha)));
}

/**
 * Same shape as costWeight but over TOTAL turn cost — money plus wall time at
 * the stall rate — instead of $/1M tokens. Needed because latency dominates:
 * measured on the live fleet at $0.50/min, the cheapest arm per token is the
 * most expensive per turn (96% of its cost is time), so a token-price-only
 * weight inverts the ranking. Feeding this to pickVec's cw bought a 23% saving
 * on the dominant arm at equal quality; the token-price-only version bought a
 * 68% money saving for a 58% time penalty.
 *
 * Takes realized per-turn money and ms (both already logged per served turn),
 * so no token modelling is required.
 */
export function turnCostWeight(
  money: number | undefined, ms: number | undefined,
  med: { money: number; ms: number }, alpha: number, stallUsdPerMin: number,
): number {
  if (!money || !(money > 0) || !ms || !(ms > 0) || alpha <= 0) return 1;
  if (!(med.money > 0) || !(med.ms > 0)) return 1;
  const total = money + (ms / 60000) * stallUsdPerMin;
  const medTotal = med.money + (med.ms / 60000) * stallUsdPerMin;
  if (!(total > 0) || !(medTotal > 0)) return 1;
  return Math.min(4, Math.max(0.25, Math.pow(medTotal / total, alpha)));
}

/** Soft-failure detection (operator design 2026-09-11): the conversation
 *  itself carries the execution verdict the judge can never see. A tool call
 *  that errored and was then re-emitted identically is an unambiguous quality
 *  failure of the arm that served the repeat. Single errors are NOT failures
 *  — probing a missing path and adjusting is normal agent life. */
export interface SoftFailCfg {
  enabled?: boolean;       // default true
  ttlMs?: number;         // served-call index entry age (default 2h)
  maxEntries?: number;     // index cap; oversize drops oldest 20% (default 5000)
  errPatterns?: string[];  // regex sources, case-insensitive (default DEFAULT_ERR_PATTERNS)
}

const DEFAULT_ERR_PATTERNS = [
  "no such file or directory", "command not found", "traceback (most recent call last)",
  "modulenotfounderror", "importerror", "syntaxerror", "exit code [1-9]", "permission denied",
];

export function toolCallHash(c: Record<string, unknown>): string {
  const f = (c.function ?? {}) as { name?: unknown; arguments?: unknown };
  // ponytail: raw-args hash — a model re-emitting byte-identical JSON matches;
  // key-reordered repeats miss (fail-safe: no regrade), not worth normalizing
  return createHash("sha256").update(`${String(f.name ?? "")}\u0000${String(f.arguments ?? "")}`).digest("hex").slice(0, 16);
}

/** Scan the conversation tail for identical tool calls repeated after an
 *  error-signature result. Returns the repeated call hashes. */
export function detectSoftFail(messages: unknown[], errRe: RegExp, window = 30): string[] {
  const seen = new Map<string, { errored: boolean }>();
  let lastAssistantHashes: string[] = []; // calls of the most recent assistant turn
  const out = new Set<string>();
  for (const m of messages.slice(-window)) {
    const msg = m as { role?: string; content?: unknown; tool_calls?: unknown };
    if (msg.role === "tool" || msg.role === "function") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      if (errRe.test(text)) for (const h of lastAssistantHashes) seen.get(h)!.errored = true;
      continue; // multiple results per turn — keep the attribution list until the next assistant turn
    }
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    lastAssistantHashes = [];
    for (const c of msg.tool_calls as Array<Record<string, unknown>>) {
      const h = toolCallHash(c);
      lastAssistantHashes.push(h);
      const prev = seen.get(h);
      if (prev?.errored) out.add(h); // identical repeat after a visible error → the serving arm failed to adapt
      else if (!prev) seen.set(h, { errored: false });
    }
  }
  return [...out];
}

/** Trusted-judge sample: true when this explore turn also gets graded by the trusted (reference) judge. */
export function trustedSample(cfg: Pick<AutoCfg, "trustedJudge" | "trustRate">, rng: () => number = Math.random): boolean {
  return !!cfg.trustedJudge && rng() < (cfg.trustRate ?? 0.05);
}

/** Comment-confirmation gate: does a trusted verdict clear the cheap judge's comment?
 *  Only a live trusted approve/heal clears; down or absent judges never do
 *  (fail safe — the redaction stays). */
export function commentCleared(tv: Ruling | undefined): boolean {
  return !!tv && !tv.down && (tv.kind === "approve" || tv.kind === "heal");
}

/** Comment verdicts: resolve the judge's FLAG refs (call id verbatim, or #1-based
 *  position) into named doubts. The end user never sees review; doubts feed
 *  the corrector forward (reviewNote). kept = ALL calls — user-side delivery
 *  stays no-withhold; redaction happens only in the corrector forward
 *  (redactFlags). No flags → no doubts. */
export function applyFlags(
  calls: Array<Record<string, unknown>>,
  flags?: Array<{ ref: string; question: string }>,
): { kept: Array<Record<string, unknown>>; doubts: string[] } {
  if (!flags?.length) return { kept: calls, doubts: [] };
  const idxById = new Map<string, number>();
  calls.forEach((c, i) => { if (c.id !== undefined) idxById.set(String(c.id), i); });
  const doubts: string[] = [];
  for (const f of flags) {
    const m = /^#(\d+)$/.exec(f.ref);
    const i = m ? Number(m[1]) - 1 : idxById.get(f.ref);
    const fn = calls[i]?.function as { name?: string } | undefined;
    doubts.push(fn?.name ? `- ${fn.name} (${f.ref}): ${f.question}` : `- ${f.question}`); // unresolvable ref → general note
  }
  return { kept: calls, doubts };
}

/** Corrector forward (operator 2026-09-10): the second TS generator sees the
 *  defective response minus its flagged calls. Unresolvable refs drop nothing
 *  (conservative — can't redact what can't be found). */
export function redactFlags(
  calls: Array<Record<string, unknown>>,
  flags?: Array<{ ref: string; question: string }>,
): Array<Record<string, unknown>> {
  if (!flags?.length) return calls;
  const idxById = new Map<string, number>();
  calls.forEach((c, i) => { if (c.id !== undefined) idxById.set(String(c.id), i); });
  const drop = new Set<number>();
  for (const f of flags) {
    const m = /^#(\d+)$/.exec(f.ref);
    const i = m ? Number(m[1]) - 1 : idxById.get(f.ref);
    if (i !== undefined && i >= 0 && i < calls.length) drop.add(i);
  }
  return calls.filter((_, i) => !drop.has(i));
}

/** db-read policy (operator 2026-09-12): a text-tool read on a binary database
 *  file is pure context poison — observed live: 11 reads of report.db in 13 min,
 *  hundreds of KB of garbage, then corrupted tool-call args from the polluted
 *  context. Deterministic strip (no LLM judgment): these calls never execute.
 *  ponytail: name+extension heuristic; a db behind an odd tool name or extension
 *  slips through — widen the regexes when new shapes show in db-read-policy rows. */
const DB_READ_TOOL_RE = /^(read|view|cat|read_?file|view_?file)$/i;
const DB_FILE_RE = /\.(db|sqlite3?|duckdb)$/i;
export function dbReadPolicy(calls: Array<Record<string, unknown>>): { kept: Array<Record<string, unknown>>; stripped: Array<Record<string, unknown>> } {
  const stripped: Array<Record<string, unknown>> = [];
  const kept = calls.filter((c) => {
    const fn = (c as { function?: { name?: string; arguments?: unknown } }).function ?? {};
    if (typeof fn.name !== "string" || !DB_READ_TOOL_RE.test(fn.name)) return true;
    let path = "";
    try {
      const a = (typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments) as Record<string, unknown> | null;
      path = String(a?.path ?? a?.file_path ?? a?.target_file ?? "");
    } catch { return true; } // unparseable args are P1's job (invalid count), not the policy's
    if (!DB_FILE_RE.test(path)) return true;
    stripped.push(c);
    return false;
  });
  return { kept, stripped };
}

/** Internal review note for the corrector — never user-visible. */
export function reviewNote(comment: string, doubts: string[]): string {
  return [
    "Your previous response was rejected by review as defective.",
    `Defect: ${comment}`,
    ...(doubts.length ? ["Questions to answer:", ...doubts] : []),
    "Produce a corrected response to the original task.",
  ].join("\n");
}

/** Correction forward: conversation + redacted response + review note →
 *  corrector regenerates in-context. */
export function buildCorrectionMessages(
  messages: unknown[],
  text: string,
  keptCalls: Array<Record<string, unknown>>,
  review: string,
): Array<Record<string, unknown>> {
  const assistant: Record<string, unknown> = { role: "assistant", content: text };
  if (keptCalls.length) assistant.tool_calls = keptCalls;
  if (!text.trim() && !keptCalls.length) assistant.content = "(response redacted by review)";
  return [...messages, assistant, { role: "user", content: review }];
}

/** Provider-side failure? 0/connect, 402/404/408/410/429, 5xx are account/provider
 *  conditions → global backoff. 400/401/403 stay per-user (2026-09-10: one bad
 *  token sprayed 401s and a shared penalty starved the ladder for everyone). */
export function providerSideErr(status: number): boolean {
  return status === 0 || status >= 500 || [402, 404, 408, 410, 429].includes(status);
}

/** Exponential backoff: minMs doubling per consecutive provider-side failure, capped at capMs (3s → 3d default). */
export function backoffDelay(fails: number, minMs = 3000, capMs = 259_200_000): number {
  return Math.min(capMs, minMs * 2 ** Math.min(fails - 1, 30));
}

/** Arms on global backoff at `now` — the cooldown half of the /v1/models
 *  catalog. Per-user error cooldowns (this.errs) are per-request state and
 *  deliberately never hide a model from the public catalog. */
export function coolingArms(arms: string[], backoff: Map<string, { fails: number; until: number }>, now: number): string[] {
  return arms.filter((m) => (backoff.get(m)?.until ?? 0) > now);
}

/** Thompson draw over live arms; explore = winner differs from argmax posterior mean.
 *  Optional per-arm prices tilt draws toward cheaper arms (posteriors untouched). */
/**
 * Exclude a whole provider family (the arm id's first path segment) from the
 * REST OF THIS TURN.
 *
 * Why: an upstream credential-level outage takes down every arm behind one
 * prefix at once, but TS scores those arms as independent draws. Observed
 * 2026-09-18: clinepass hit its monthly account quota (429
 * INFERENCE_CAP_ERROR, surfaced by the gateway as 503) and all 13
 * `clinepass/*` arms in the reasoning partition died simultaneously. They were
 * cheap and well-rated, so they sat at the top of the cost-weighted draw
 * distribution — a turn burned all 5 attempts inside that one dead family and
 * returned 502 while healthy families (ali/*, minimax/*) were never sampled.
 * Excluding the family after its first failure turns "5 attempts on one dead
 * account" into "1 attempt, then move on".
 *
 * Scoped to the turn's `excluded` set, NOT to `errsOf(user)` or `backoff`:
 * cross-turn recovery stays with the existing cooldown/backoff machinery, and
 * any 200 still clears global backoff. A family that is briefly down is not
 * punished beyond the turn that discovered it.
 *
 * ponytail: also skips healthy siblings of a genuinely per-MODEL outage.
 * Acceptable — the remaining attempts go to other families, which is the
 * coverage property a turn needs. Narrow to cap/429 semantics if per-model
 * outages turn out to be common.
 */
export function excludeFamily(excluded: Set<string>, arms: string[], model: string): void {
  const slash = model.indexOf("/");
  if (slash < 0) { excluded.add(model); return; } // no family prefix — just this arm
  const fam = model.slice(0, slash + 1);
  for (const a of arms) if (a.startsWith(fam)) excluded.add(a);
}

export function pickArm(
  arms: string[],
  st: Record<string, ArmStat> | undefined,
  excluded: Set<string>,
  errs: Map<string, number>,
  now: number,
  cooldownMs = 0, // defaulted: a missing cfg key must not exclude every arm (Infinity > undefined is false)
  rng: () => number,
  prices?: Record<string, number>,
  alpha = 0.5,
  hot?: Set<string>,   // arms with a hot upstream prefix-cache for this conversation
  cacheFactor = 1,     // effective price multiplier for hot arms (<1 = discount)
): Pick | { error: string } {
  const live = arms.filter((m) => !excluded.has(m) && now - (errs.get(m) ?? -Infinity) > cooldownMs);
  if (live.length === 0) return { error: "all arms excluded or cooling down" };
  // ponytail: flat price×factor, no input/output split — prompt tokens are
  // ~99% of an agent turn's cost (57k in vs ~700 out measured), so the flat
  // factor ≈ the provider's cached-input discount on the total bill.
  const eff = (m: string) => (hot?.has(m) && prices?.[m] ? prices[m] * cacheFactor : prices?.[m]);
  const med = median(live.map((m) => eff(m)).filter((p): p is number => p !== undefined && p > 0));
  let best = live[0], bestDraw = -1, meanBest = live[0], bestMean = -1;
  for (const m of live) {
    const s = st?.[m] ?? { a: 1, b: 1 };
    const w = costWeight(eff(m), med, alpha);
    const draw = betaSample(s.a, s.b, rng) * w;
    if (draw > bestDraw) { bestDraw = draw; best = m; }
    const mean = (s.a / (s.a + s.b)) * w;
    if (mean > bestMean) { bestMean = mean; meanBest = m; }
  }
  return { model: best, explore: best !== meanBest };
}

/** Exploit policy (captain ruling 2026-09-10; gate 0.99→0.90 on 2026-09-11:
 *  a ~5% natural miss rate pins proven arms at mean≈0.95, so 0.99 was
 *  unreachable by construction — 0/311 turns exploited. 0.90 lets the
 *  workhorses through, e.g. chat/minimax 262W/15L ≈ 0.95): exploit ≤90% of
 *  traffic, only when the top arm's raw posterior mean exceeds the gate.
 *  B judges explore turns only — beta never moves on exploit turns. */
export const EXPLOIT_GATE = 0.90;
export const EXPLOIT_SHARE = 0.9;

/** Greedy pick: live arm with the highest raw posterior mean (no cost weight —
 *  the gate is a quality bar, not a price bar). */
export function topArm(
  arms: string[],
  st: Record<string, ArmStat> | undefined,
  excluded: Set<string>,
  errs: Map<string, number>,
  now: number,
  cooldownMs: number,
): { model: string; mean: number } | { error: string } {
  const live = arms.filter((m) => !excluded.has(m) && now - (errs.get(m) ?? -Infinity) > cooldownMs);
  if (live.length === 0) return { error: "all arms excluded or cooling down" };
  let best = live[0], bestMean = -1;
  for (const m of live) {
    const s = st?.[m] ?? { a: 1, b: 1 };
    const mean = s.a / (s.a + s.b);
    if (mean > bestMean) { bestMean = mean; best = m; }
  }
  return { model: best, mean: bestMean };
}

/** Exploit eligibility: the greedy arm when its raw beta clears the gate and
 *  the 90% coin lands; null → explore this turn. */
export function exploitPick(
  arms: string[],
  st: Record<string, ArmStat> | undefined,
  excluded: Set<string>,
  errs: Map<string, number>,
  now: number,
  cooldownMs: number,
  rng: () => number,
): Pick | null {
  const top = topArm(arms, st, excluded, errs, now, cooldownMs);
  if ("error" in top || top.mean <= EXPLOIT_GATE || rng() >= EXPLOIT_SHARE) return null;
  return { model: top.model, explore: false };
}

export function applyReward(state: TsState, cls: string, model: string, ok: boolean): void {
  const c = (state[cls] ??= {});
  const s = (c[model] ??= { a: 1, b: 1 });
  if (ok) s.a += 1; else s.b += 1;
}

/** Turn-scope injection (2026-09-10): prepend the detected class as a system
 *  hint so the upstream model knows the register the turn wants (goal-setting
 *  turns read very different from chat). Off by default; judges and the chosen
 *  arm both see it. ponytail: per-class flip mid-conversation breaks upstream
 *  prefix-cache on the flip turn only — self-heals next turn. */
export function withTurnScope(messages: unknown[], cls: string, on: boolean): unknown[] {
  if (!on || !messages?.length) return messages;
  return [{ role: "system", content: `[turn scope: ${cls}]` }, ...messages];
}

export function parseClass(text: string, classes: string[], fallback: string): string {
  const m = text.toLowerCase().match(new RegExp(`\\b(${classes.join("|")})\\b`));
  return m ? m[1] : fallback;
}

/** Attacker ruling. Last RULING: line wins (attacker thinks first).
 *  Heal arrays are validated against the request's tools — an invalid heal
 *  degrades to a comment. No RULING line → undefined (caller fails open). */
export type Ruling =
  | { kind: "approve"; down?: boolean }
  | { kind: "heal"; calls: Array<Record<string, unknown>> }
  | { kind: "comment"; comment: string; flags?: Array<{ ref: string; question: string }> }
  | { kind: "deny"; comment?: string; skipped?: boolean };

export function parseRuling(text: string, tools?: unknown): Ruling | undefined {
  const hits = [...text.matchAll(/RULING:\s*(SILENT-APPROVE|HEAL-TOOL-CALL|RESPOND-BLOCKING-COMMENT|STEALTH-DENY-RETRY)/gi)];
  if (!hits.length) return undefined;
  const last = hits[hits.length - 1];
  if (!last) return undefined;
  const kind = (last[1] ?? "").toUpperCase();
  const prose = text.slice(0, last.index ?? 0).replace(/```[\s\S]*?```/g, "").trim();
  if (kind === "SILENT-APPROVE") return { kind: "approve" };
  if (kind === "STEALTH-DENY-RETRY") return { kind: "deny", comment: prose };
  if (kind === "RESPOND-BLOCKING-COMMENT") {
    const flags = [...text.matchAll(/^\s*FLAG\s+([^\s:]+)\s*:\s*(\S.+)$/gim)]
      .map((m) => ({ ref: (m[1] ?? "").trim(), question: (m[2] ?? "").trim() }))
      .filter((f) => f.question);
    const comment = prose.replace(/^\s*FLAG\s+[^\n]+$/gim, "").trim() || "response flagged by review";
    return { kind: "comment", comment, ...(flags.length ? { flags } : {}) };
  }
  // HEAL-TOOL-CALL — fenced array, validated against the request's tools
  const names = new Set<string>();
  if (Array.isArray(tools))
    for (const t of tools as Array<{ function?: { name?: string } }>) if (t?.function?.name) names.add(t.function.name);
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const healed = fence?.[1];
  if (healed && names.size) try {
    const calls = JSON.parse(healed) as Array<Record<string, unknown>>;
    const valid = Array.isArray(calls) && calls.length > 0 && calls.every((c) => {
      const fn = (c as { function?: { name?: string; arguments?: unknown } })?.function;
      if (!fn?.name || !names.has(fn.name)) return false;
      try { JSON.parse(typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {})); return true; } catch { return false; }
    });
    if (valid) return { kind: "heal", calls };
  } catch { /* degrade below */ }
  return { kind: "comment", comment: prose || "attacker heal failed validation" };
}

const normId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Match a pool arm (cf/@cf/meta/llama-3.1-70b-…) to an OpenRouter id (meta-llama/llama-3.1-70b-instruct):
 *  exact normalized match on leaf/base first, then containment (nb ≥ 6 chars). */
export function matchMarketId(arm: string, marketIds: string[]): string | undefined {
  const leaf = arm.split("/").slice(1).join("/").replace(/^@cf\//, ""); // strip pool prefix + @cf/
  const nb = normId(leaf);
  if (!nb) return undefined;
  for (const id of marketIds) {
    const parts = id.split("/");
    const leafN = normId(parts[parts.length - 1]);
    if (leafN === nb || normId(parts.slice(1).join("/")) === nb) return id;
  }
  if (nb.length >= 6) for (const id of marketIds) {
    const on = normId(id);
    if (on.includes(nb)) return id;
    const onb = normId(id.split("/").pop() ?? ""); // leaf-vs-leaf: catches -fp8-fast style suffix variants
    if (onb.length >= 6 && (onb.includes(nb) || nb.includes(onb))) return id;
  }
  return undefined;
}

/** Per-arm $/1M blended price map: real observed (paid), else freeFactor×market shadow, else median fill. */
export function buildPriceMap(
  arms: string[],
  hist: Record<string, number>,                 // 9router model id → observed $/1M (paid arms only)
  market: Array<{ id: string; blend: number }>, // OpenRouter id → blended $/1M
  freeFactor: number,
): Record<string, number> {
  const ids = market.map((m) => m.id);
  const byId = new Map(market.map((m) => [m.id, m.blend]));
  const map: Record<string, number> = {};
  for (const arm of arms) {
    const real = hist[arm.split("/").slice(1).join("/")]; // strip pool prefix → 9router model id
    if (real && real > 0) { map[arm] = real; continue; }
    const oid = matchMarketId(arm, ids);
    const blend = oid ? byId.get(oid) : undefined;
    if (blend && blend > 0) map[arm] = freeFactor * blend;
  }
  const med = median(Object.values(map));
  for (const arm of arms) if (!(arm in map)) map[arm] = med; // unknown → neutral weight
  return map;
}

/** Last user message's text, truncated. */
export function lastUserText(body: unknown, max = 1500): string {
  const msgs = (body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages;
  if (!Array.isArray(msgs)) return "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    const txt = typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((p: { type?: string; text?: string }) => (p?.type === "text" ? p.text ?? "" : "")).join(" ")
        : "";
    if (txt.trim()) return txt.trim().slice(0, max);
  }
  return "";
}

// ---------- pure helpers (tested) ----------

/**
 * Rewrite "developer" role → "system" on message arrays.
 * Mirrors the inline logic in rewriteBody() (server.ts). Some upstream gateways
 * reject the OpenAI "developer" role with a 400; every endpoint here accepts "system".
 */
export function normalizeMessages(messages: unknown): unknown[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const m of messages as Record<string, unknown>[])
    if (m && m.role === "developer") m.role = "system";
  return messages as unknown[];
}

/** L0 deterministic heal, no LLM: names fuzzy-mapped to the request's declared
 *  tools, object args stringified, stringified-JSON args unwrapped, garbage
 *  args reset to "{}". healed=true iff anything changed. */
export function healToolCalls(tools: unknown, calls: Array<Record<string, unknown>>): { calls: Array<Record<string, unknown>>; healed: boolean; invalid: number } {
  const norm = (s: string): string => s.toLowerCase().replace(/[-_]/g, "");
  const names = new Map<string, string>(); // normalized → real
  if (Array.isArray(tools))
    for (const t of tools as Array<{ function?: { name?: string } }>) {
      const n = t?.function?.name;
      if (n) names.set(norm(n), n);
    }
  // ponytail: depth cap 4 — stringified-JSON unwrap terminates even on hostile input
  const canon = (s: string, depth = 0): string | undefined => {
    if (depth > 4 || !s.trim()) return undefined;
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object") return s;
      if (typeof v === "string") return canon(v, depth + 1); // stringified JSON — unwrap
    } catch { /* not JSON */ }
    return undefined;
  };
  let healed = false;
  let invalid = 0; // P1: structurally broken calls (unmapped name, unparseable args)
  const out = calls.map((c, i) => {
    const fn = (c as { function?: { name?: string; arguments?: unknown } }).function ?? {};
    let name = typeof fn.name === "string" ? fn.name : "";
    const real = names.get(norm(name));
    if (real) { if (real !== name) { name = real; healed = true; } }
    else invalid++; // no schema tool matches — nonexistent tool
    let args: string;
    if (typeof fn.arguments === "string") args = fn.arguments;
    else { args = JSON.stringify(fn.arguments ?? {}); healed = true; }
    const fixed = canon(args);
    if (fixed === undefined) {
      if (args.trim()) invalid++; // non-empty but unparseable JSON
      args = "{}"; healed = true;
    }
    else if (fixed !== args) { args = fixed; healed = true; }
    return { ...(c as object), id: (c as { id?: string }).id ?? `call_${i}`, type: "function", function: { name, arguments: args } };
  });
  return { calls: out, healed, invalid };
}

/** Compact tool listing for the attacker: `- name(required params)` per line. */
export function toolSummary(tools: unknown): string {
  if (!Array.isArray(tools) || !tools.length) return "(no tools available)";
  return tools.slice(0, 40).map((t) => {
    const fn = (t as { function?: { name?: string; parameters?: { required?: string[] } } }).function ?? {};
    const req = fn.parameters?.required?.length ? `(${fn.parameters.required.join(", ")})` : "()";
    return `- ${fn.name ?? "unknown"}${req}`;
  }).join("\n");
}

// ---------- runtime ----------

type Res = import("node:http").ServerResponse;
type Req = import("node:http").IncomingMessage;

export class AutoLlm {
  private dir: string;
  private cfg: AutoCfg | null = null;
  private cfgMtime = 0;
  private state: TsState = {};
  private stateMtime = 0;
  /** phase-1 vector-routing shadow hook (auto-vec): fired fire-and-forget
   *  at the served-turn log with the final entry + mission/ask text. */
  observe?: (entry: Record<string, unknown>, text: string) => void;
  /** phase-2 vector-routing hook (auto-vec), injected by server.ts on the same
   *  seam as `observe` so auto-llm never imports auto-vec (auto-vec imports US).
   *  Returns the zone for this turn's text, or null when inert. ok() is the
   *  caller's health view — universe, exclusion, cooldown, backoff — because only
   *  auto-llm knows it. A vec pick rides the EXPLORE path: the P1 gate and the
   *  db-read policy still run on it. Confidence in an arm is not a licence to
   *  skip the attack gate. */
  vecRoute?: (text: string, ok: (arm: string) => boolean) => Promise<
    { zone: "ts"; why: string } | { zone: "vec" | "gold"; arm: string } | null>;
  /** Global per-arm backoff — rate limits/quotas recover, so arms are never
   *  hard-disabled: provider-side statuses double the penalty (3s → 3d cap),
   *  any 200 resets. ponytail: in-memory; a restart during an outage re-probes
   *  and rebuilds — acceptable, failures fail fast. */
  private backoff = new Map<string, { fails: number; until: number }>();

  /** Per-user arm cooldown: user → arm → lastErrTs. 2026-09-10: an unknown
   *  external token sprayed upstream 401s on minimax arms and, with a shared
   *  map, cooled them for EVERY user → ladder starved to 0 live arms. */
  private errs = new Map<string, Map<string, number>>();
  private errsOf(user: string): Map<string, number> {
    let m = this.errs.get(user);
    if (!m) { m = new Map(); this.errs.set(user, m); }
    return m;
  }

  /** Upstream prefix-cache heat: conversation key → arm → last 200-completion ts.
   *  Cache lives at the upstream model (model+account scoped, exact-prefix,
   *  TTL-bounded) — so heat is set on ANY upstream 200, even a turn we later
   *  redact: the provider already processed the prefix. Restart = cold start
   *  (fine: one undiscounted pick, self-heals next turn). */
  private hot = new Map<string, Map<string, number>>();
  private markHot(convKey: string | undefined, arm: string): void {
    if (!convKey) return;
    let m = this.hot.get(convKey);
    if (!m) {
      if (this.hot.size >= 4096) this.hot.delete(this.hot.keys().next().value!); // ponytail: LRU cap, matches HOME_CAP
      m = new Map();
      this.hot.set(convKey, m);
    }
    m.set(arm, Date.now());
  }
  private universe: string[] = [];
  private universeAt = 0;
  private prices: Record<string, number> = {};
  private pricesAt = 0;
  private pricingBusy = false;

  /** Live arms = leaf models on the gateway (provider/name), minus judge+excludes. */
  private async getUniverse(cfg: AutoCfg, token: string): Promise<string[]> {
    const ttl = cfg.universeTtlMs ?? 300_000;
    if (this.universe.length && Date.now() - this.universeAt < ttl) return this.universe;
    try {
      const res = await fetch(cfg.gateway.replace(/\/chat\/completions$/, "/models"), {
        headers: { authorization: `Bearer ${token}` },
      });
      const j = (await res.json()) as { data?: Array<{ id?: string; capabilities?: { imageOutput?: boolean; audioOutput?: boolean } }> };
      const excl = (cfg.armsExclude ?? []).map((r) => new RegExp(r));
      // leaf models = "provider/…" (slashless ids are combos → never arms);
      // chat-capable only (no image/audio-output models)
      this.universe = (j.data ?? [])
        .filter((m) => !m.capabilities?.imageOutput && !m.capabilities?.audioOutput)
        .map((m) => m.id ?? "")
        .filter((id) => id.includes("/"))
        .filter((id) => !excl.some((re) => re.test(id)));
      this.universeAt = Date.now();
    } catch { /* keep stale universe on gateway hiccup */ }
    return this.universe;
  }

  /** Catalog for GET /v1/models: live 9router arms split into data (usable
   *  now) and cooling (global backoff active). Null → no config or unreadable
   *  gateway key → caller falls back to the static project-mask surface. */
  async models(): Promise<{ data: string[]; cooling: string[] } | null> {
    const cfg = this.loadCfg();
    if (!cfg) return null;
    let token = "";
    try { token = readFileSync(join(this.dir, cfg.keyFile), "utf8").trim(); }
    catch { return null; }
    const arms = await this.getUniverse(cfg, token);
    const cooling = new Set(coolingArms(arms, this.backoff, Date.now()));
    return { data: arms.filter((m) => !cooling.has(m)), cooling: [...cooling] };
  }

  /** Kick a price refresh off the request path — never block a request on a slow fetch. */
  private maybeRefreshPrices(cfg: AutoCfg, arms: string[]): void {
    const pc = cfg.pricing;
    if (!pc || this.pricingBusy || Date.now() - this.pricesAt < (pc.refreshMs ?? 3_600_000)) return;
    this.pricingBusy = true;
    void this.refreshPrices(cfg, arms, pc).catch(() => {}).finally(() => { this.pricingBusy = false; });
  }

  /** Real $/1M from 9router usageHistory (paid arms); freeFactor×OpenRouter shadow for free arms. */
  private async refreshPrices(cfg: AutoCfg, arms: string[], pc: PriceCfg): Promise<void> {
    const hist: Record<string, number> = {};
    try {
      const { DatabaseSync } = await import("node:sqlite"); // readonly over 9router's WAL db
      const db = new DatabaseSync(pc.historyDb ?? join(homedir(), ".9router/db/data.sqlite"), { readOnly: true });
      const min = pc.historyMinTokens ?? 2000;
      const rows = db.prepare(
        "SELECT model, SUM(cost) c, SUM(promptTokens+completionTokens) t FROM usageHistory WHERE status='ok' GROUP BY model",
      ).all() as Array<{ model: string; c: number; t: number }>;
      for (const r of rows) if (r.t >= min && r.c > 0) hist[r.model] = (r.c / r.t) * 1e6; // $/1M observed
      db.close();
    } catch { /* 9router db absent/unreadable → real prices just missing */ }
    let market: Array<{ id: string; blend: number }> = [];
    if (arms.some((a) => !(a.split("/").slice(1).join("/") in hist))) { // shadows needed
      const cache = pc.marketCache ?? join(this.dir, "deploy/market-prices.json");
      try {
        const mt = statSync(cache).mtimeMs;
        if (Date.now() - mt < (pc.marketTtlMs ?? 86_400_000)) market = JSON.parse(readFileSync(cache, "utf8"));
      } catch { /* no cache */ }
      if (!market.length) try {
        const res = await fetch(pc.marketUrl ?? "https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20_000) });
        const j = (await res.json()) as { data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }> };
        market = (j.data ?? [])
          .filter((m) => m.id && m.pricing)
          .map((m) => ({ id: m.id!, blend: ((Number(m.pricing?.prompt) + Number(m.pricing?.completion)) / 2) * 1e6 }))
          .filter((m) => m.blend > 0);
        try { writeFileSync(cache, JSON.stringify(market)); } catch { /* cache is best-effort */ }
      } catch { /* offline → shadows absent this round, median fill */ }
    }
    this.prices = buildPriceMap(arms, hist, market, pc.freeFactor ?? 0.3);
    this.pricesAt = Date.now();
  }

  constructor(dir: string) { this.dir = dir; }

  private loadCfg(): AutoCfg | null {
    const p = join(this.dir, "deploy/auto-llm.json");
    try {
      const mt = statSync(p).mtimeMs;
      if (!this.cfg || mt !== this.cfgMtime) {
        this.cfg = JSON.parse(readFileSync(p, "utf8")) as AutoCfg;
        this.cfgMtime = mt;
      }
      return this.cfg;
    } catch { return null; }
  }

  private loadState(cfg: AutoCfg): void {
    const p = join(this.dir, cfg.stateFile);
    let mt = 0;
    try { mt = statSync(p).mtimeMs; } catch { /* first run */ }
    if (mt !== this.stateMtime) {
      let disk: TsState = {};
      try { disk = JSON.parse(readFileSync(p, "utf8")); } catch { /* fresh */ }
      // pretrain priors merge UNDER observed state (observations always win)
      const merged: TsState = JSON.parse(JSON.stringify(cfg.pretrain ?? {}));
      for (const [cls, arms] of Object.entries(disk))
        for (const [m, s] of Object.entries(arms))
          (merged[cls] ??= {})[m] = s;
      this.state = merged;
      this.stateMtime = mt;
    }
  }

  private save(cfg: AutoCfg): void {
    try { writeFileSync(join(this.dir, cfg.stateFile), JSON.stringify(this.state, null, 1)); } catch { /* disk full etc — TS just loses persistence */ }
  }

  // served-call index: call hash → the arm that delivered it. Written at
  // delivery, consumed by softFailScan on the NEXT request of the conversation.
  private servedCalls = new Map<string, { cls: string; model: string; ts: number }>();

  private mapServedCalls(cfg: AutoCfg, user: string, cls: string, model: string, calls: Array<Record<string, unknown>>): void {
    if (cfg.softFail?.enabled === false) return;
    const now = Date.now();
    const max = cfg.softFail?.maxEntries ?? 5000;
    if (this.servedCalls.size >= max) { // GC: age first, then oldest fifth
      const ttl = cfg.softFail?.ttlMs ?? 7_200_000;
      for (const [k, v] of this.servedCalls) if (now - v.ts > ttl) this.servedCalls.delete(k);
      if (this.servedCalls.size >= max) {
        const byAge = [...this.servedCalls].sort((x, y) => x[1].ts - y[1].ts);
        for (let i = 0; i < Math.floor(byAge.length * 0.2); i++) this.servedCalls.delete(byAge[i][0]);
      }
    }
    for (const c of calls) this.servedCalls.set(user + toolCallHash(c), { cls, model, ts: now });
  }

  /** Non-blocking next-turn feedback: scan the incoming conversation for
   *  repeated-after-error calls, downgrade each serving arm (b += 1). Pure
   *  in-memory scan — no LLM, no I/O before the pick, so this turn's draw
   *  already benefits. One regrade per served call (entry consumed). */
  private softFailScan(cfg: AutoCfg, user: string, messages: unknown[]): void {
    if (cfg.softFail?.enabled === false || this.servedCalls.size === 0) return;
    try {
      const pats = cfg.softFail?.errPatterns ?? DEFAULT_ERR_PATTERNS;
      const errRe = new RegExp(pats.join("|"), "i");
      let applied = 0;
      for (const h of detectSoftFail(messages, errRe)) {
        const k = user + h;
        const e = this.servedCalls.get(k);
        if (!e) continue;
        applyReward(this.state, e.cls, e.model, false);
        this.servedCalls.delete(k);
        applied++;
        this.log(cfg, { user, cls: e.cls, model: e.model, mode: "soft-fail", call: h });
      }
      if (applied) this.save(cfg);
    } catch { /* best-effort — never touches the serve path */ }
  }

  private log(cfg: AutoCfg, entry: Record<string, unknown>): void {
    try { appendFileSync(join(this.dir, cfg.logFile), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"); } catch { /* telemetry is best-effort */ }
  }

  /** $/1M blended for the log (undefined → omitted by JSON.stringify). */
  private pxOf(m: string): number | undefined {
    const p = this.prices[m];
    return p && p > 0 ? Math.round(p * 1000) / 1000 : undefined;
  }

  private async gatewayCall(cfg: AutoCfg, token: string, model: string, messages: unknown[], extra?: Record<string, unknown>): Promise<{ ok: boolean; status: number; json?: Record<string, unknown>; raw?: Response }> {
    let res: Response;
    try {
      res = await fetch(cfg.gateway, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...extra, model, messages }),
      });
    } catch {
      // connect-level failure (ECONNREFUSED/DNS/timeout): dead arm fails over
      // via the callers' !ok path — never an unhandled rejection that kills
      // the whole silo (2026-09-09 outage: 9router down → 4× crash-loop)
      return { ok: false, status: 0 };
    }
    if (!res.ok) return { ok: false, status: res.status };
    if (extra?.stream) return { ok: true, status: res.status, raw: res };
    try {
      const text = await res.text();
      let j = JSON.parse(text.split("data: [DONE]")[0]) as Record<string, unknown>;
      // 9router quirk: some connections (cline) wrap as {"data":{"choices":…}}
      const inner = j.data as Record<string, unknown> | undefined;
      if (!j.choices && inner?.choices) j = inner;
      return { ok: true, status: res.status, json: j };
    } catch { return { ok: false, status: res.status }; }
  }

  /** Judge failover chain (2026-09-11): primary judge → cfg.judgePool order,
   *  first gateway-ok call wins; all fail → callers keep their existing
   *  fail-open paths (ali flapped dark on 50% of turns, max run 169).
   *  Explicit model (trusted judge) never falls over — trusted grading stays
   *  single-shot fail-safe (a down trusted judge never clears).
   *  thinking:disabled always rides along: glm honors it (25s→1.8s probed
   *  2026-09-11), qwen ignores it harmlessly. */
  private async judgeCall(cfg: AutoCfg, token: string, model: string | undefined, messages: unknown[], extra: Record<string, unknown>): Promise<{ ok: boolean; status: number; json?: Record<string, unknown> }> {
    const pool = model === undefined ? [cfg.judge, ...(cfg.judgePool ?? [])] : [model];
    let last: { ok: boolean; status: number; json?: Record<string, unknown> } = { ok: false, status: 0 };
    for (const m of pool) {
      last = await this.gatewayCall(cfg, token, m, messages, { ...extra, thinking: { type: "disabled" } });
      if (last.ok) return last;
    }
    return last;
  }

  /** B: attacker triage on every completed turn. Empty turn → deny without
   *  a B call; B unreachable/garbled → fail open (approve). */
  private async attack(cfg: AutoCfg, token: string, task: string, turn: string, calls: Array<Record<string, unknown>>, tools?: unknown, model?: string): Promise<Ruling> {
    if (!turn.trim() && !calls.length) return { kind: "deny", skipped: true };
    if (TOOL_LEAK_RE.test(turn)) return { kind: "deny", skipped: true }; // leaked tool-call markup as text
    const turnText = turn.slice(0, 3000) + (calls.length
      ? "\n\nTOOL CALLS:\n" + JSON.stringify(calls.slice(0, 10), null, 1).slice(0, 4000)
      : "");
    const v = await this.judgeCall(cfg, token, model, [
      { role: "user", content: ATTACK_PROMPT.replace("{TASK}", task.slice(0, 800)).replace("{TOOLS}", toolSummary(tools)).replace("{TURN}", turnText) },
    ], { stream: false, max_tokens: cfg.judgeMaxTokens ?? 500, temperature: 0 });
    if (!v.ok || !v.json) return { kind: "approve", down: true }; // B down → fail open — pair logging reads "down", never a verdict
    const text = String((v.json as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "");
    return parseRuling(text, tools) ?? { kind: "approve" }; // garbled → fail open
  }

  /** P2 hold-back stream pump: assembles text + tool_calls but writes NOTHING
   *  to the client — verdict precedes delivery, so a deny fully redacts.
   *  finish_reason chunks and [DONE] are dropped (re-emitted by finishSse);
   *  unparseable/keep-alive lines are dropped (held-back stream is synthetic). */
  private async pumpStream(raw: Response, model: string): Promise<{ text: string; toolCalls: Array<Record<string, unknown>> }> {
    void model;
    const reader = raw.body?.getReader();
    if (!reader) return { text: "", toolCalls: [] };
    let buf = "", text = "";
    const parts: Record<number, { id?: string; name?: string; args: string }> = {};
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trimEnd();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue; // held-back: keep-alives dropped
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string; message?: { content?: string } }>;
            };
            // 9router quirk: some connections wrap as {"data":{"choices":…}}
            const choices = j.choices ?? (j as { data?: { choices?: typeof j.choices } }).data?.choices;
            const d = choices?.[0];
            const delta = (d?.delta ?? d?.message) as { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } | undefined;
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const i = tc.index ?? 0;
                const p = parts[i] ?? { args: "" };
                if (tc.id) p.id = tc.id;
                if (tc.function?.name) p.name = tc.function.name;
                if (tc.function?.arguments) p.args += tc.function.arguments;
                parts[i] = p;
              }
              continue;
            }
            if (d?.finish_reason) continue; // re-emitted synthetically in finishSse
            if (delta?.content) { text += delta.content; continue; }
            // role-only / usage chunks — drop
          } catch { /* held-back: unparseable data line dropped */ }
        }
      }
    } catch { /* upstream aborted mid-stream: keep what we have */ }
    return {
      text,
      toolCalls: Object.entries(parts).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, p], i) => ({
        id: p.id ?? `call_${i}`,
        type: "function",
        function: { name: p.name ?? "", arguments: p.args || "{}" },
      })),
    };
  }

  /** Emit the synthetic tail of a held-back stream: replayed content chunk,
   *  held tool_calls, finish_reason, [DONE]. Sends headers on first write
   *  (P2 hold-back: nothing reaches the client before the verdict). */
  private finishSse(res: Res, model: string, opts: { tail?: string; toolCalls?: Array<Record<string, unknown>> } = {}): void {
    if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream", "x-served-model": model });
    if (opts.tail) res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: opts.tail } }] })}\n\n`);
    if (opts.toolCalls?.length) res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { tool_calls: opts.toolCalls.map((c, i) => ({ index: i, id: (c as { id?: string }).id ?? `call_${i}`, type: "function", function: { name: (c as { function?: { name?: string } }).function?.name ?? "", arguments: (c as { function?: { arguments?: unknown } }).function?.arguments ?? "{}" } })) } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: opts.toolCalls?.length ? "tool_calls" : "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }

  /** Returns true if the response was fully handled. */
  async handle(req: Req, res: Res, body: Buffer, user: string, clientToken: string): Promise<boolean> {
    const cfg = this.loadCfg();
    if (!cfg) return false; // no config → fall through to normal routing
    this.loadState(cfg);
    const t0 = Date.now();
    const reqBytes = body.length; // free — the buffer is already in hand (3qw fix #4)


    // gateway token: caller's own key, else the key file. A missing/unreadable
    // key file is a deploy error — 503 the caller, never crash the silo.
    let token = clientToken;
    if (!token) {
      try {
        token = readFileSync(join(this.dir, cfg.keyFile), "utf8").trim();
      } catch {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "auto-llm: gateway key unreadable" }));
        return true;
      }
    }

    let parsedBody: unknown;
    try { parsedBody = JSON.parse(body.toString()); } catch { return false; }
    const jb = parsedBody as Record<string, unknown>;
    // ponytail: normalize "developer" role → "system" before forwarding to
    // upstream gateways. Some upstream endpoints (tokenrouter, Alibaba-compatible,
    // etc.) reject the OpenAI "developer" role with a 400. Every endpoint here
    // accepts "system". Mirrors rewriteBody() in server.ts.
    normalizeMessages(jb.messages);
    const userText = lastUserText(parsedBody);

    // Pre-flight budget check (3qw). An oversized prompt starves max_tokens, and a
    // reasoning model then spends the WHOLE budget on <think> — ali arms come back
    // literally empty (gate "empty"), minimax arms come back with a non-empty
    // reasoning fragment that clears the empty gate and is then rightly DENIED by
    // P1. Both halves are the same defect, and neither can be fixed by retrying:
    // every attempt re-sends the same 100k+ token prompt. Fail before paying for
    // classify + completion. Reproduced 2026-09-18: a 149k-token conversation
    // against a 128k declared window burned 40 paid upstream sends for 1 usable
    // turn (27 empty, 10 denied, 3 serve-error, 8 exhausted).
    // ponytail: a genuine "huge prompt, one-word answer" request also 400s. It
    // could not be delivered anyway — a sub-64-token reply from a reasoning model
    // is a think fragment the P1 gate denies. Raise 64 if that ever changes.
    const mx = Number(jb.max_tokens ?? 0);
    if (reqBytes > EMPTY_FAILFAST_BYTES && mx > 0 && mx < 64) {
      this.log(cfg, { user, mode: "request-too-large", reqBytes, mx, stage: "preflight" });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `auto-llm: request too large (${Math.round(reqBytes / 1024)}KB) for its output budget (max_tokens=${mx}). The conversation exceeds the model context window, so no arm can produce a deliverable answer. Compact the session or start a new one.` }));
      return true;
    }

    this.softFailScan(cfg, user, jb.messages as unknown[]); // execution feedback from the prior turn, before this pick

    // 1. classify
    let cls = cfg.unknownClass;
    if (userText) {
      const c = await this.judgeCall(cfg, token, undefined, [
        { role: "user", content: `classify-only. Reply with exactly one word from: ${cfg.classes.join(", ")}. Task: ${userText}` },
      ], { stream: false, max_tokens: 8, temperature: 0 });
      if (c.ok && c.json) {
        const content = (c.json as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
        cls = parseClass(String(content), cfg.classes, cfg.unknownClass);
      }
    }
    jb.messages = withTurnScope(jb.messages, cls, !!cfg.injectTurnScope);

    const arms = await this.getUniverse(cfg, token);
    if (arms.length === 0) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "auto-llm: empty model universe (gateway down?)" }));
      return true;
    }
    this.maybeRefreshPrices(cfg, arms); // off the request path — never blocks

    // Cache-aware pricing: arms whose upstream prefix-cache is hot for this
    // conversation draw at price × cacheFactor (see pickArm).
    const convKey = affinityKeyFromBody(body);
    const hot = new Set<string>();
    {
      const h = convKey ? this.hot.get(convKey) : undefined;
      const ttl = cfg.pricing?.cacheTtlMs ?? 1_800_000;
      if (h) for (const [m, ts] of h) if (Date.now() - ts < ttl) hot.add(m);
    }
    const excluded = new Set<string>();
    const armSet = new Set(arms);
    // vec text: mission anchor (first user msg) + the ask. Computed ONCE and used
    // by BOTH route() and observe() — if the query string and the stored string
    // differ, the k-NN query does not match the rows it is scored against.
    const firstU = Array.isArray(jb.messages) ? (jb.messages.find((m) => (m as { role?: string })?.role === "user") as { content?: unknown } | undefined)?.content : undefined;
    const vecText = `${String(firstU ?? "").slice(0, 1200)}\n…\n${userText}`;
    const wantStream = jb.stream === true;
    let attempts = 0;
    let lastModel = "";
    let lastVz: string | undefined; // which zone routed the turn, for the log

    // Global backoff seeds the turn's exclusion set — provider-side failures
    // cool the arm for ALL users (pickArm + exploit gate both respect `excluded`).
    for (const [m, b] of this.backoff) if (b.until > Date.now()) excluded.add(m);

    // Exploit gate (2026-09-10): greedy arm streams through, no B, no reward —
    // decided once per turn; dead/cooling arm falls back to the explore path.
    let exploitArm = exploitPick(arms, this.state[cls], excluded, this.errsOf(user), Date.now(), cfg.cooldownMs, Math.random)?.model ?? null;

    // explore: A completes (TS-picked), B attacks. exploit: greedy arm, L0 heal only.
    while (attempts <= cfg.maxRetries) {
      const now = Date.now();
      let pick: Pick | { error: string };
      if (exploitArm) {
        const dead = excluded.has(exploitArm) || now - (this.errsOf(user).get(exploitArm) ?? -Infinity) <= cfg.cooldownMs;
        if (dead) exploitArm = null;
      }
      if (exploitArm) pick = { model: exploitArm, explore: false };
      else {
        // Vector-field routing (phase 2). Decided per attempt with fresh health
        // state, so a vec arm that just failed or cooled drops back to class TS.
        // Abstain (ts) and inert (null) both fall through to pickArm unchanged.
        const okVec = (a: string) => armSet.has(a) && !excluded.has(a)
          && now - (this.errsOf(user).get(a) ?? -Infinity) > (cfg.cooldownMs ?? 0)
          && !(this.backoff.get(a)?.until > now);
        const z = this.vecRoute ? await this.vecRoute(vecText, okVec) : null;
        // Re-verify on the way back. routeZone filters with ok(), but a pick is
        // only as safe as the CALLER's check: never serve an arm the universe,
        // exclusion set, cooldown, or backoff has vetoed, whatever the callee said.
        const useVec = !!z && z.zone !== "ts" && okVec(z.arm);
        lastVz = z ? (useVec ? z.zone : "ts") : undefined;
        if (useVec) pick = { model: (z as { arm: string }).arm, explore: true };
        else pick = pickArm(arms, this.state[cls], excluded, this.errsOf(user), now, cfg.cooldownMs, Math.random, this.prices, cfg.pricing?.alpha ?? 0.5, hot, cfg.pricing?.cacheFactor ?? 0.5);
      }
      if ("error" in pick) break;
      lastModel = pick.model;
      attempts++;
      const wasHot = hot.has(pick.model); // discount applied at pick time (markHot below records this turn for the NEXT ones)

      const call = await this.gatewayCall(cfg, token, pick.model, jb.messages as unknown[], { ...jb, model: undefined, stream: wantStream });
      if (!call.ok) {
        this.errsOf(user).set(pick.model, Date.now());
        if (providerSideErr(call.status)) {
          const fails = (this.backoff.get(pick.model)?.fails ?? 0) + 1;
          this.backoff.set(pick.model, { fails, until: Date.now() + backoffDelay(fails, cfg.backoffMinMs ?? 3000, cfg.backoffCapMs ?? 259_200_000) });
        }
        applyReward(this.state, cls, pick.model, false);
        excludeFamily(excluded, arms, pick.model); // a dead credential kills every sibling — do not spend the budget on them
        this.log(cfg, { user, cls, model: pick.model, mode: "serve-error", status: call.status, attempts, explore: pick.explore, px: this.pxOf(pick.model) });
        continue;
      }

      this.backoff.delete(pick.model); // any 200 = arm works; reset global backoff

      // assemble A's turn — P2 hold-back: streamed content is buffered, nothing
      // reaches the client until the verdict, so a deny fully redacts
      let text = "";
      let calls: Array<Record<string, unknown>> = [];
      if (call.raw) {
        const p = await this.pumpStream(call.raw, pick.model);
        text = p.text; calls = p.toolCalls;
      } else {
        const msg = ((call.json as { choices?: Array<{ message?: Record<string, unknown> }> })?.choices?.[0]?.message ?? {}) as Record<string, unknown>;
        text = String(msg.content ?? "");
        if (Array.isArray(msg.tool_calls)) calls = msg.tool_calls as Array<Record<string, unknown>>;
      }

      // L0 deterministic heal — name fuzzy-map + arg repair, zero LLM cost
      const l0 = healToolCalls(jb.tools, calls);
      if (convKey) this.markHot(convKey, pick.model); // upstream 200 → prefix cache warm (even if we later redact)

      // P1 degeneracy gate — ALL traffic (exploit included), before any delivery.
      // Hold-back guarantees nothing reached the client, so reject = full redact + resample.
      const gate = gateReason(text, l0.calls.length, l0.invalid);
      if (gate) {
        // Request-determined, not arm-determined: an oversized prompt starves the
        // output budget, so EVERY arm returns empty and retrying only re-pays for
        // the same send. Fail fast with a 4xx the client will not retry, and do
        // NOT touch beta — the arm is not at fault (3qw fixes #1 + #3).
        if (gate === "empty" && reqBytes > EMPTY_FAILFAST_BYTES) {
          this.log(cfg, { user, cls, model: pick.model, mode: "request-too-large", gate, attempts, reqBytes, mx, px: this.pxOf(pick.model) });
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `auto-llm: request too large (${Math.round(reqBytes / 1024)}KB) — upstream returned an empty completion because the conversation exceeds the model context window. Compact the session or start a new one.` }));
          return true;
        }
        applyReward(this.state, cls, pick.model, false);
        excludeFamily(excluded, arms, pick.model); // superseded excluded.add: a gate-reject is usually request-determined (over-budget → empty), so siblings fail identically
        this.log(cfg, { user, cls, model: pick.model, mode: "gate-reject", gate, attempts, reqBytes, mx, explore: pick.explore });
        continue;
      }

      // db-read policy (operator 2026-09-12): strip binary-db text reads before
      // ANY delivery (exploit included) and ride the correction loop so the fixer
      // regenerates with guidance. The synthesized ruling overrides the cheap
      // judge AND skips the trusted override — a deterministic operator ruling,
      // not a judgment call. Hard-stripped again at final delivery below.
      const dbp = dbReadPolicy(l0.calls);
      let policyRuling: Ruling | undefined;
      if (dbp.stripped.length) {
        const refs = l0.calls.map((c, i) => (dbp.stripped.includes(c) ? `#${i + 1}` : null)).filter(Boolean) as string[];
        policyRuling = {
          kind: "comment",
          comment: `POLICY (operator ruling): ${dbp.stripped.length} tool call(s) tried to read a binary database file with a text tool. Database files (.db/.sqlite/.sqlite3/.duckdb) are NEVER read as text — query them with the sqlite3 CLI via bash using targeted SELECT statements.`,
          flags: refs.map((ref) => ({ ref, question: "text read of a binary db file — replace with a targeted sqlite3 SELECT via bash" })),
        };
        exploitArm = null; // a policy turn is judged/corrected, never fast-served unjudged
        this.log(cfg, { user, cls, model: pick.model, mode: "db-read-policy", stripped: dbp.stripped.length, attempts });
      }

      if (exploitArm) {
        // exploit: no B, no reward — beta never moves on unjudged turns
        this.log(cfg, { user, cls, model: pick.model, mode: "exploit", explore: false, ms: Date.now() - t0, attempts, px: this.pxOf(pick.model), hot: wasHot || undefined });
        if (l0.calls.length) this.mapServedCalls(cfg, user, cls, pick.model, l0.calls);
        if (call.raw) this.finishSse(res, pick.model, { tail: text, toolCalls: l0.calls });
        else {
          res.writeHead(200, { "content-type": "application/json", "x-served-model": pick.model });
          res.end(JSON.stringify({
            ...(call.json as object),
            model: pick.model,
            choices: [{ index: 0, message: { role: "assistant", content: text, ...(l0.calls.length ? { tool_calls: l0.calls } : {}) }, finish_reason: l0.calls.length ? "tool_calls" : "stop" }],
          }));
        }
        return true;
      }

      // explore: B attacker triage (beta rises only on approve-without-edits)
      const ruling = policyRuling ?? await this.attack(cfg, token, userText, text, l0.calls, jb.tools);
      // trusted judge: ~5% of explore turns also graded by the trusted (reference) judge;
      // paired verdicts judge the cheap-judge POOL, not the turn. Reward/delivery unchanged.
      // A failed judge call logs "down" — a dead judge must never read as agreement.
      // ponytail: inline adds one judge round trip to sampled turns; async fire-and-forget if latency shows.
      const t2 = policyRuling ? undefined : trustedSample(cfg) ? await this.attack(cfg, token, userText, text, l0.calls, jb.tools, cfg.trustedJudge) : undefined;
      const entry = { user, cls, model: pick.model, ruling: ruling.kind, down: ruling.down || undefined, explore: pick.explore, ms: Date.now() - t0, attempts, px: this.pxOf(pick.model), hot: wasHot || undefined, ...(lastVz ? { vz: lastVz } : {}), trusted: t2 && `${ruling.down ? "down" : ruling.kind}/${t2.down ? "down" : t2.kind}` };

      if (ruling.kind === "deny") {
        // The deny half of the same defect: an over-window request yields a
        // non-answer that P1 rightly denies on EVERY arm, so resampling only
        // re-pays for the same oversized send. Request-determined → no beta
        // penalty, non-retryable 400. Restricted to genuine judge denials:
        // a `skipped` deny is an empty turn (already gated) or leaked tool
        // markup, which IS arm-specific — a sibling may answer cleanly.
        if (reqBytes > EMPTY_FAILFAST_BYTES && !ruling.skipped) {
          this.log(cfg, { user, cls, model: pick.model, mode: "request-too-large", stage: "denied", attempts, reqBytes, mx, px: this.pxOf(pick.model) });
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `auto-llm: request too large (${Math.round(reqBytes / 1024)}KB) — the completion was rejected as non-responsive because the conversation exceeds the model context window. Compact the session or start a new one.` }));
          return true;
        }
        applyReward(this.state, cls, pick.model, false);
        excluded.add(pick.model); // P2: nothing was ever sent — full redaction, resample
        this.log(cfg, { ...entry, mode: "denied-retry", skipped: ruling.skipped });
        continue;
      }

      let deliverText = text;
      let deliverCalls = l0.calls;

      // comment-confirmation gate (2026-09-10): the cheap-judge combo over-flags
      // (RRDM: three comments in 4 min, all false — the trusted pair said approve
      // and the operator confirmed the flagged model was real). A comment only
      // delivers when the trusted judge agrees; a trusted approve/heal overrides
      // to approve — tools intact, no pause. Every escalation logs its pair
      // (promotion evidence). Skip when the arm IS the trusted judge (lineage:
      // never self-overrule); a down trusted judge never clears (fail safe).
      let kind = ruling.kind;
      let tv: Ruling | undefined;
      if (kind === "comment" && !policyRuling && cfg.trustedJudge && pick.model !== cfg.trustedJudge) {
        tv = t2 ?? await this.attack(cfg, token, userText, text, l0.calls, jb.tools, cfg.trustedJudge);
        entry.trusted = tv && `${ruling.down ? "down" : ruling.kind}/${tv.down ? "down" : tv.kind}`;
        if (commentCleared(tv)) kind = "approve";
      }

      if (ruling.kind === "heal") deliverCalls = healToolCalls(jb.tools, ruling.calls).calls; // L0 again: B may emit object args
      let deliverModel = pick.model;
      let baseJson = call.json as object;
      let rounds = 0;
      let corrected = false;
      if (kind === "comment") {
        // Correction loop (operator 2026-09-10): review is INVISIBLE to the
        // end user — no advisory text ever ships. Defective response → redact
        // flagged calls → forward [conversation + redacted response + review]
        // to a second TS generator → re-review, up to correctionRounds (3).
        // The turn always ends on the newest response — held back, never
        // killed. Being corrected impacts beta (applyReward false per
        // corrected arm; final approval rewards the corrector).
        // ponytail: a correction round costs one gen + one judge round trip;
        // async fire-and-forget the loop if latency shows.
        applyReward(this.state, cls, pick.model, false); // corrected → beta impact
        const c = (tv?.kind === "comment" ? tv : ruling) as Extract<Ruling, { kind: "comment" }>;
        let flags = c.flags;
        let note = reviewNote(c.comment, applyFlags(l0.calls, flags).doubts);
        excluded.add(pick.model); // corrector = a different TS model
        for (; rounds < (cfg.correctionRounds ?? 3); rounds++) {
          const pick2 = pickArm(arms, this.state[cls], excluded, this.errsOf(user), Date.now(), cfg.cooldownMs, Math.random, this.prices, cfg.pricing?.alpha ?? 0.5, hot, cfg.pricing?.cacheFactor ?? 0.5);
          if ("error" in pick2) break;
          excluded.add(pick2.model);
          const messages = buildCorrectionMessages(jb.messages as unknown[], deliverText, redactFlags(deliverCalls, flags), note);
          const call2 = await this.gatewayCall(cfg, token, pick2.model, messages, { ...jb, model: undefined, stream: false });
          if (!call2.ok || !call2.json) {
            this.errsOf(user).set(pick2.model, Date.now());
            if (providerSideErr(call2.status)) {
              const fails = (this.backoff.get(pick2.model)?.fails ?? 0) + 1;
              this.backoff.set(pick2.model, { fails, until: Date.now() + backoffDelay(fails, cfg.backoffMinMs ?? 3000, cfg.backoffCapMs ?? 259_200_000) });
            }
            applyReward(this.state, cls, pick2.model, false);
            continue;
          }
          this.backoff.delete(pick2.model); // any 200 = arm works
          const msg = ((call2.json as { choices?: Array<{ message?: Record<string, unknown> }> })?.choices?.[0]?.message ?? {}) as Record<string, unknown>;
          const t2text = String(msg.content ?? "");
          const t2calls = Array.isArray(msg.tool_calls) ? msg.tool_calls as Array<Record<string, unknown>> : [];
          const l0b = healToolCalls(jb.tools, t2calls);
          if (gateReason(t2text, l0b.calls.length, l0b.invalid)) { applyReward(this.state, cls, pick2.model, false); continue; }
          const r2 = await this.attack(cfg, token, userText, t2text, l0b.calls, jb.tools);
          deliverText = t2text; deliverCalls = l0b.calls; deliverModel = pick2.model; baseJson = call2.json as object; // newest ships if the loop ends here
          if (r2.kind === "approve") { applyReward(this.state, cls, pick2.model, true); corrected = true; break; }
          if (r2.kind === "heal") { deliverCalls = healToolCalls(jb.tools, r2.calls).calls; corrected = true; break; } // edited → beta never rises
          applyReward(this.state, cls, pick2.model, false); // comment/deny → corrected next round
          if (r2.kind === "comment") {
            flags = r2.flags;
            note = reviewNote(r2.comment, applyFlags(l0b.calls, flags).doubts);
          } else {
            note = reviewNote(r2.comment || "prior attempt was incoherent", []); // deny → no usable review text
            flags = undefined;
          }
        }
      } else if (kind === "approve") {
        applyReward(this.state, cls, pick.model, true); // heal = edited = never raises beta
      }
      // policy hard-strip: db reads never execute even if correction exhausted or
      // a corrector re-emitted one (r2 approve can't bless a policy violation).
      // ponytail: stripping post-exhaustion can leave a tool_call without its
      // result row next turn — pi synthesizes an error result; if a client ever
      // chokes, emit placeholder results instead of dropping.
      const dbp2 = dbReadPolicy(deliverCalls);
      if (dbp2.stripped.length) {
        deliverCalls = dbp2.kept;
        if (!deliverCalls.length && !deliverText.trim()) deliverText = "Withheld by policy: query .db files with sqlite3 via bash (targeted SELECT), not a text read.";
        this.log(cfg, { user, cls, model: deliverModel, mode: "db-read-stripped", stripped: dbp2.stripped.length });
      }
      this.save(cfg);
      const mode = kind === "comment" ? (corrected ? "corrected" : "correction-failed") : ruling.kind === "comment" ? "comment-overruled" : kind === "heal" ? "served-heal" : "served";
      this.log(cfg, { ...entry, ms: Date.now() - t0, mode, ...(rounds ? { rounds } : {}) });
      if (deliverCalls.length) this.mapServedCalls(cfg, user, cls, deliverModel, deliverCalls); // explore delivery joins (heal-path calls re-healed above; ceiling: pre-heal l0 hash mismatch = missed regrade, fail-safe)
      if (this.observe) {
        this.observe({ ...entry, mode }, vecText);
      }

      if (call.raw) {
        // P2: held-back content replays in full on the verdict — corrected or
        // not, the client sees one clean response, never a review artifact
        this.finishSse(res, deliverModel, { tail: deliverText, toolCalls: deliverCalls });
        return true;
      }
      res.writeHead(200, { "content-type": "application/json", "x-served-model": deliverModel });
      res.end(JSON.stringify({
        ...baseJson,
        model: deliverModel,
        choices: [{ index: 0, message: { role: "assistant", content: deliverText, ...(deliverCalls.length ? { tool_calls: deliverCalls } : {}) }, finish_reason: deliverCalls.length ? "tool_calls" : "stop" }],
      }));
      return true;
    }

    this.log(cfg, { user, cls, model: lastModel, mode: "exhausted", ms: Date.now() - t0, attempts, reqBytes, mx, ...(lastVz ? { vz: lastVz } : {}), px: this.pxOf(lastModel) });
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `auto-llm: no arm survived (${cls}, ${attempts} attempts)` }));
    return true;
  }
}

export const AUTO_ALIAS = "auto-llm";
export function autoLlmDir(): string { return join(import.meta.dirname ?? "."); }
export const autoLlm = new AutoLlm(autoLlmDir());
export const hasCfg = (): boolean => existsSync(join(autoLlmDir(), "deploy/auto-llm.json"));
