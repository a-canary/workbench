// estimator.ts — P-EST: pure passive estimator. Recovers a provider's hidden
// rate-limit window + cap from organic (ts, tokens, status) outcomes only.
// NEVER probes. Unknown until the first 429→success cycle is observed.
// Port of the seed-42 reference sim (estimator-sim.ts): spend-at-block = cap
// lower-bound (max), 429→first-success gap = window bound (median).

export type Outcome = { ts: number; provider: string; tokens: number; status: string };

export type Estimate = {
  provider: string;
  known: boolean; // true once a window length has been inferred
  windowHours: number | null; // median window-class 429→first-success gap
  capLB: number | null; // max spend-at-block, trailing RECENT_DAYS
  weeklyCapLB: number | null; // max trailing-7d spend at weekly-class blocks
  blocked: boolean; // last observation is an unresolved 429
  spendInWindow: number; // ok-tokens since last inferred window boundary
  headroomFrac: number | null; // (capLB - spendInWindow) / capLB, clamped [0,1]
  blocks: number; // distinct 429 onsets observed
};

const H = 3600;
// ponytail: trailing-max keeps silent plan downgrades from poisoning capLB for
// more than RECENT_DAYS; widen only if a provider blocks less than weekly.
const RECENT_DAYS = 7;
const WEEKLY_GAP_H = 12; // a reset gap beyond this (and 2× window) = weekly-class block

const unknown = (provider: string, blocked = false): Estimate => ({
  provider, known: false, windowHours: null, capLB: null, weeklyCapLB: null,
  blocked, spendInWindow: 0, headroomFrac: null, blocks: 0,
});

export function estimate(rows: Outcome[], provider: string): Estimate {
  const rs = rows.filter((r) => r.provider === provider).sort((a, b) => a.ts - b.ts);
  if (rs.length === 0) return unknown(provider);

  // pass 1 — block onsets, reset gaps, refill anchors (first success after a 429)
  type Block = { ts: number; gapH: number | null };
  const blocksArr: Block[] = [];
  const anchors: number[] = [];
  let blocked = false;
  for (const r of rs) {
    if (r.status === "429") {
      if (!blocked) { blocksArr.push({ ts: r.ts, gapH: null }); blocked = true; }
    } else if (blocked) {
      blocksArr[blocksArr.length - 1].gapH = (r.ts - blocksArr[blocksArr.length - 1].ts) / H;
      anchors.push(r.ts);
      blocked = false;
    }
  }
  if (blocksArr.length === 0) return { ...unknown(provider), blocks: 0 };

  // Window length: refill anchors land on true window boundaries, so the mode
  // of consecutive anchor deltas (hour-rounded) is the window; each delta is a
  // multiple of it. (Median 429→success gap only bounds it — blocks hit
  // mid-window.) Smallest delta wins a tie-break.
  const deltaCount = new Map<number, number>();
  for (let i = 1; i < anchors.length; i++) {
    const d = Math.round((anchors[i] - anchors[i - 1]) / H);
    if (d > 0 && d <= WEEKLY_GAP_H) deltaCount.set(d, (deltaCount.get(d) ?? 0) + 1);
  }
  let windowHours: number | null = null;
  for (const [d, n] of deltaCount) {
    const best = windowHours === null ? 0 : deltaCount.get(windowHours)!;
    if (n > best || (n === best && windowHours !== null && d < windowHours)) windowHours = d;
  }
  if (windowHours === null || windowHours <= 0) {
    return { ...unknown(provider, blocked), blocks: blocksArr.length };
  }

  const isWeekly = (b: Block) => b.gapH !== null && b.gapH > Math.max(WEEKLY_GAP_H, 2 * windowHours);

  // pass 2 — spend per inferred window (boundaries = refill anchors + k·window)
  const winSec = windowHours * H;
  let ai = 0, curAnchor = rs[0].ts, curBoundary = rs[0].ts, spend = 0;
  const spendAtBlock = new Map<number, number>(); // block ts → spend since boundary
  for (const r of rs) {
    while (ai < anchors.length && anchors[ai] <= r.ts) curAnchor = anchors[ai++];
    const b = curAnchor + Math.floor((r.ts - curAnchor) / winSec) * winSec;
    if (b !== curBoundary) { curBoundary = b; spend = 0; }
    if (r.status === "429") { if (!spendAtBlock.has(r.ts)) spendAtBlock.set(r.ts, spend); }
    else spend += r.tokens;
  }

  const lastTs = rs[rs.length - 1].ts;
  const recent = (ts: number) => ts >= lastTs - RECENT_DAYS * 24 * H;
  const windowBlocks = blocksArr.filter((b) => !isWeekly(b));
  const pool = windowBlocks.filter((b) => recent(b.ts)).length ? windowBlocks.filter((b) => recent(b.ts)) : windowBlocks;
  const capLB = pool.length ? Math.max(...pool.map((b) => spendAtBlock.get(b.ts) ?? 0)) : null;

  let weeklyCapLB: number | null = null;
  for (const b of blocksArr.filter(isWeekly)) {
    const wkSpend = rs.filter((r) => r.status !== "429" && r.ts > b.ts - 7 * 24 * H && r.ts <= b.ts)
      .reduce((s, r) => s + r.tokens, 0);
    weeklyCapLB = Math.max(weeklyCapLB ?? 0, wkSpend);
  }

  const headroomFrac = capLB ? Math.min(1, Math.max(0, (capLB - spend) / capLB)) : null;
  return {
    provider, known: true, windowHours, capLB, weeklyCapLB, blocked,
    spendInWindow: spend, headroomFrac, blocks: blocksArr.length,
  };
}
