// auto-vec.ts — vector-routing shadow mode (2026-09-11 pivot, phase 1).
//
// Embed each served turn locally, find its top-k neighborhood among stored
// results, build per-arm Beta posteriors of adequacy (kernel-weighted +
// ts-state shrinkage prior). Two gates before an exploit pick: match
// (simFloor — low vector match = OOD → never quick-serve a stale posterior)
// and sharpness (P(best>2nd) + nEffFloor). Standing eps explore. Exploit pick
// is the strongest adequate arm; cheapest-of-adequate lands at flip-live when
// the market price map is wired in (the log already carries the full set).
//
// SHADOW: observe() is fire-and-forget, off the request path, fails open on
// every error, and serves nothing. Live routing (a/b pair serve + compare
// judge, verdicts a/b/neither/both) comes after shadow data proves
// neighborhoods sharpen at real traffic.
//
// Embedding input = first user message (mission) + last user message (ask),
// head+tail sliced into the model window — the graded unit is THIS turn's
// serve, so trailing history is deliberately excluded (verdict/vector
// alignment; history floods mean-pooled embeddings and collapses the
// neighborhoods that make routing discriminate).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { betaSample, median, turnCostWeight } from "./auto-llm.ts";

// ponytail: mirror auto-llm's pricing.alpha and local-llm's stallUsdPerMin.
// Read them from cfg if the two ever diverge; one cost model is the point.
const COST_ALPHA = 0.5;
const STALL_USD_PER_MIN = 0.5;

export interface VecCfg {
  shadow?: boolean;
  /** live routing (phase 2): route() steers the pick — OOD → gold arms,
   *  sharp neighborhood → strongest adequate arm, else class TS. */
  live?: boolean;
  /** gold arms for OOD (novel) prompts: sim < simFloor means pooled-class TS
   *  is exactly the cheap-lottery trap (meta/mimo pinned at the 0.90 gate) —
   *  route novel work to known-strong models until the neighborhood learns. */
  gold?: string[];
  model?: string;
  k?: number;
  simFloor?: number;
  nEffFloor?: number;
  sharpFloor?: number;
  eps?: number;
  /** Quality gate, applied to the WILSON LOWER BOUND (see wilsonLcb), not the
   *  mean. Default 0.82. This is a scale change from the mean-based 0.9 the
   *  shadow config carries: on the bound, 0.9 needs n>=25 even for a flawless
   *  arm and bars a 98% arm at n=33 (bound 0.891), so 0.9 would abstain always.
   *  0.82 admits a 98% arm from n~16 and a 90% arm only from n~60. Any deployed
   *  adequacyFloor MUST be restated when this build ships. */
  adequacyFloor?: number;
  /** one-sided z for the Wilson quality bound (default 1.64 = 95%). Raising it
   *  makes the router demand more verified evidence before exploiting an arm. */
  riskZ?: number;
  /** ts-state global arm prior weight per arm (shrinkage toward the
   *  class system's learned strengths; cold neighborhoods inherit them). */
  priorWeight?: number;
  storeFile?: string;
  binFile?: string;
  logFile?: string;
  priorFile?: string;
  /** sidecar carrying {dim, rows} so dim is never inferred from file sizes */
  metaFile?: string;
  /** neighbours kept per arm (spec s2) */
  perArm?: number;
  /** floor on the inverse-distance kernel (spec s3) */
  distEps?: number;
  /** FIFO row cap (spec s17) */
  maxRows?: number;
  /** log full diagnostics for the first N observes of this process
   *  (counter is in-memory; a restart grants another N). 0 = compact lines. */
  verboseNext?: number;
}

export interface VecResult {
  i: number; ts: number; arm: string;
  /** delivery fact, NOT quality: true only when mode==="served". Legacy rows
   *  carry nothing else, so qualityOutcome() falls back to it for them. */
  ok: boolean;
  /** mode at observe time; its presence marks a post-uncensor row */
  md?: string;
  /** judge ruling (approve|comment|deny). THE quality signal: 12.4% of turns
   *  are non-approve and separate arms (chi2=70.0/5df) where `ok` (1.8%) cannot. */
  r?: string;
  /** wall ms and per-1M price of the served turn — cost must price time, not
   *  just tokens (token-only cw sent 75% of turns to an 8-obs slow arm). */
  ms?: number; px?: number;
}

export interface ObserveEntry { model: string; mode: string; down?: boolean; ruling?: string; ms?: number; px?: number }

/** Quality evidence in a stored row, or undefined when the row carries none.
 *  Availability failures must never enter beta — beta tracks QUALITY, backoff
 *  tracks availability. Legacy censored rows predate `md`/`r` and only ever
 *  stored approvals, so `ok` is their best available signal. */
export function qualityOutcome(r: VecResult): boolean | undefined {
  if (r.r !== undefined) return r.r === "approve";
  if (r.md !== undefined) return undefined;   // judged-less/availability row
  return r.ok;
}

/** Wilson lower bound on a Binomial success rate. Exploiting an arm whose
 *  failures have not been observed is the expensive mistake — a response that
 *  derails the session or causes material loss costs orders of magnitude more
 *  than the price gap that made the arm look attractive. Gating and ranking on
 *  the pessimistic bound prices that risk from the evidence already in hand,
 *  so no dollar figure has to be invented for it. Returns 0 for n<=0. */
export function wilsonLcb(a: number, b: number, z = 1.64): number {
  const n = a + b;
  if (!(n > 0)) return 0;
  const p = a / n, z2 = z * z, d = 1 + z2 / n;
  const lcb = (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / d;
  return lcb > 0 ? lcb : 0;
}

export interface ArmStat {
  arm: string; a: number; b: number; mean: number;
  /** pessimistic quality bound; what pickVec gates and ranks on (see wilsonLcb) */
  lcb: number;
  /** local evidence weight actually contributing (post dup-cap) */
  w?: number;
}

/** Jeffreys floor on each Beta pseudocount; see the note in neighborhood(). */
const PSEUDOCOUNT = 0.5;

export interface Neighborhood {
  nEff: number; sim: number; best: number; sharp: boolean; stats: ArmStat[];
  /** top-k cosine sims, descending — verbose calibration/debug */
  topSims: number[];
  /** distinct arms contributing evidence — the coverage number the global
   *  top-k hid (spec s2). 2 on the old retrieval, 15 on per-arm-16. */
  arms: number;
}

/** Vectors plus the per-row identity of their embedding. `dupId` lets the
 *  kernel cap repeated identical prompts: 95.6% of the live store is exact
 *  duplicates (203 distinct vectors / 1669 rows), and uncapped they let one
 *  26-character prompt served 57× buy nEff=50 of false confidence (spec s4). */
export interface VecStore {
  dim: number; vecs: Float32Array; results: VecResult[]; dupId: Int32Array;
}

export interface NbOpts {
  rng: () => number;
  /** neighbours kept per arm (spec s2). Replaces the global top-k for evidence. */
  perArm?: number;
  /** global nearest kept for the OOD `sim` gate only — stratifying this would
   *  drag the mean down with distant rare arms and misfire the gate. */
  k?: number;
  simFloor?: number; nEffFloor?: number; sharpFloor?: number;
  /** light hint only; 16 real neighbours must be able to override it (spec s6) */
  priorWeight?: number;
  /** floor on inverse-distance weight: 1/(1-sim+eps). Unbounded 1/dist is
   *  rejected — duplicates sit at sim=1.000 exactly (spec s3). */
  distEps?: number;
  /** one-sided z for the Wilson bound on quality (default 1.64 = 95%). This is
   *  the hidden-cost knob: raising it prices unverified exploitation higher. */
  riskZ?: number;
}

/** 64-bit FNV over the raw float bits → stable identity for one embedding.
 *  Collisions only merge evidence for two identical-by-hash vectors, which at
 *  100k rows is far cheaper than a real dedup structure. */
export function vecId(vecs: Float32Array, off: number, dim: number): string {
  const u = new Uint32Array(vecs.buffer, vecs.byteOffset + off * 4, dim);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let d = 0; d < dim; d++) {
    const x = u[d];
    h1 = Math.imul(h1 ^ x, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (x >>> 16), 16777619) >>> 0;
  }
  return (h1 >>> 0).toString(36) + "." + (h2 >>> 0).toString(36);
}

/** Head+tail slice into the embedder window: the ask usually lives at the
 *  end, the mission at the start. Tail-heavy. */
export function sliceText(text: string, head = 1200, tail = 2000): string {
  if (text.length <= head + tail) return text;
  return text.slice(0, head) + "\n…\n" + text.slice(-tail);
}

/** Per-arm kernel-weighted k-NN bandit posterior for query q (normalized).
 *  Stored rows are pre-normalized, so cosine = dot.
 *
 *  Retrieval is stratified: the `perArm` closest rows OF EACH ARM, not the
 *  global closest (spec s2). A global top-k is always won by whichever two
 *  arms carry most traffic, so the long tail is never retrieved at all.
 *
 *  Weight fades with distance as 1/(1-sim+distEps) — measured 11.3× dynamic
 *  range vs 4.3× for the old sim², without the 517,000× blow-up of unbounded
 *  1/dist on exact duplicates (spec s3).
 *
 *  Each (arm, identical-embedding) cell is capped at its own largest single
 *  row weight, so repeating one prompt buys no extra confidence while a
 *  genuinely close single match still counts in full (spec s4).
 *
 *  Per-arm a/b shrunk toward the pooled ts-state prior. P(best>2nd) by 200
 *  Monte Carlo beta draws (~ms). */
export function neighborhood(
  q: Float32Array, store: VecStore, prior: Map<string, { a: number; b: number }>, o: NbOpts,
): Neighborhood {
  const { dim, vecs, results, dupId } = store;
  const perArm = o.perArm ?? 16, k = o.k ?? 50, distEps = o.distEps ?? 0.05;
  const priorWeight = o.priorWeight ?? 0.013;
  const empty: Neighborhood = { nEff: 0, sim: 0, best: 0, sharp: false, stats: [], topSims: [], arms: 0 };
  const n = Math.min(Math.floor(vecs.length / dim), results.length);
  if (n <= 0) return empty;

  const sims = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    let dot = 0;
    const off = r * dim;
    for (let d = 0; d < dim; d++) dot += q[d] * vecs[off + d];
    sims[r] = dot;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => sims[y] - sims[x]);

  // OOD gate reads the GLOBAL nearest — what it asks is "does this turn look
  // like anything we have seen", not "is every arm's local evidence close".
  const head = order.slice(0, Math.min(k, n));
  const sim = head.reduce((t, i) => t + sims[i], 0) / head.length;
  const simFloor = o.simFloor ?? 0.55;

  const kept = new Map<string, number>();
  const cellRaw = new Map<string, number>(), cellMax = new Map<string, number>(), cellOk = new Map<string, number>();
  for (const i of order) {
    // Row-level relevance floor, not just a query-level average. Inverse
    // distance gives even an antithetical row (sim=-1) weight ~0.49, so
    // without this 67 arms x 16 distant rows would reach nEff>=30 on pure
    // garbage and the density gate would certify nothing. `order` is
    // descending, so the first miss ends the scan.
    if (sims[i] < simFloor) break;
    const r = results[i];
    if (!r) continue;
    const q = qualityOutcome(r);
    // No quality evidence (availability failure) → not beta material, and it
    // must not spend this arm's perArm retrieval budget either.
    if (q === undefined) continue;
    const c = kept.get(r.arm) ?? 0;
    if (c >= perArm) continue;   // this arm already contributed its closest perArm
    kept.set(r.arm, c + 1);
    const w = 1 / (1 - sims[i] + distEps);
    const key = r.arm + "\u0000" + dupId[i];
    cellRaw.set(key, (cellRaw.get(key) ?? 0) + w);
    cellMax.set(key, Math.max(cellMax.get(key) ?? 0, w));
    if (q) cellOk.set(key, (cellOk.get(key) ?? 0) + w);
  }

  const acc = new Map<string, { a: number; b: number; w: number }>();
  let nEff = 0;
  for (const [key, raw] of cellRaw) {
    const cap = cellMax.get(key) ?? raw;
    const scale = raw > cap ? cap / raw : 1;   // duplicates add nothing past one row
    const w = raw * scale, okW = (cellOk.get(key) ?? 0) * scale;
    const arm = key.slice(0, key.indexOf("\u0000"));
    const st = acc.get(arm) ?? { a: 0, b: 0, w: 0 };
    st.a += okW; st.b += w - okW; st.w += w;
    acc.set(arm, st);
    nEff += w;
  }

  const stats: ArmStat[] = [...acc.entries()].map(([arm, { a, b, w }]) => {
    const p = prior.get(arm);
    // The pseudocount floor is deliberately NOT priorWeight*(a+b): at
    // priorWeight=0.013 an arm with no local failures gets b0=0.013, and
    // gammaSample(0.013) ~ rng()^77 makes ga/(ga+gb) land on exactly 1.0 for
    // ~87% of draws. Every all-win arm then ties and P(A>B) inverts — measured
    // 0.300 for A=(36.7 wins) vs B=(2.2 wins). Jeffreys' 0.5 gives 0.836 with
    // zero ties. priorWeight still shrinks toward the pooled prior; the floor
    // only keeps the Beta numerically meaningful.
    const a0 = a + Math.max((p?.a ?? 1) * priorWeight, PSEUDOCOUNT);
    const b0 = b + Math.max((p?.b ?? 1) * priorWeight, PSEUDOCOUNT);
    return { arm, a: a0, b: b0, mean: a0 / (a0 + b0), lcb: wilsonLcb(a0, b0, o.riskZ), w };
  }).sort((x, y) => y.lcb - x.lcb);
  let best = 0;
  if (stats.length >= 2) {
    for (let d = 0; d < 200; d++) if (betaSample(stats[0].a, stats[0].b, o.rng) > betaSample(stats[1].a, stats[1].b, o.rng)) best++;
    best /= 200;
  } else if (stats.length === 1) best = 1;
  const sharp = nEff >= (o.nEffFloor ?? 30) && sim >= simFloor && best >= (o.sharpFloor ?? 0.9);
  return { nEff, sim, best, sharp, stats, topSims: head.map((i) => sims[i]), arms: stats.length };
}

/** Strongest arm of the adequate set (Wilson lower bound >= adequacyFloor).
 *  Stats are sorted
 *  by mean, so the first adequate entry wins; cheapest-of-adequate is a
 *  flip-live change once prices are wired (adequate set is logged for that). */
/**
 * Choose among quality-adequate arms. `cw` maps arm -> costWeight, the same
 * (median/price)^alpha the class-TS draw multiplies by, so both layers agree on
 * one cost model instead of vec inventing a second one.
 *
 * costFirst is the point of this function. On an easy turn the judge cannot
 * separate two competent arms, so their posteriors overlap and `sharp` is false.
 * That is not a reason to abstain - it is the case where the cheap arm wins for
 * free, because quality is equal within measurement resolution. The aggregate
 * saving over millions of tokens lives almost entirely in this band, so when
 * quality ties, cost decides outright and quality only breaks exact cost ties.
 * When quality genuinely separates (sharp), quality leads with cost as the
 * multiplier, mirroring `betaSample(a,b) * costWeight(...)`.
 *
 * CONTRACT ON cw: it must price TIME as well as MONEY. The objective is total
 * cost of a turn, and latency dominates: at the $0.50/min stall rate the
 * cheapest-per-token arm in the live fleet is the MOST expensive per turn (96%
 * of its cost is wall time). A cw built from $/1M tokens alone inverts the
 * ranking and buys a 68% money saving for a 58% time penalty. Callers must pass
 * a weight derived from price + latency.
 */
export function pickVec(
  stats: ArmStat[], adequacyFloor: number,
  cw?: (arm: string) => number, costFirst = false,
): string | null {
  const ok = stats.filter((s) => s.lcb >= adequacyFloor);
  if (!ok.length) return null;
  const w = (s: ArmStat) => (cw ? cw(s.arm) : 1);
  if (!costFirst) {
    return [...ok].sort((a, b) => b.lcb * w(b) - a.lcb * w(a))[0].arm;
  }
  return [...ok].sort((a, b) => w(b) - w(a) || b.lcb - a.lcb)[0].arm;
}

export type RouteZone =
  | { zone: "ts"; why: "ood" | "eps" | "inadequate" }
  | { zone: "vec" | "gold"; arm: string };

/** Live routing decision (phase 2, pure): OOD → gold (no eps — every novel
 *  prompt deserves gold); otherwise the cheapest quality-adequate arm when the
 *  neighbourhood cannot separate arms on quality, or the strongest adequate arm
 *  when it can. ok() health-filters arms (universe/backoff/cooldown) BEFORE the
 *  pick, so an unhealthy winner falls through to next-best rather than to ts. */
export function routeZone(
  nb: { nEff: number; sim: number; best: number; sharp: boolean; stats: ArmStat[] },
  cfg: Pick<VecCfg, "simFloor" | "adequacyFloor" | "eps" | "gold">,
  rng: () => number,
  ok?: (arm: string) => boolean,
  cw?: (arm: string) => number,
): RouteZone {
  if (nb.sim < (cfg.simFloor ?? 0.55)) {
    const gold = (cfg.gold ?? []).filter((a) => !ok || ok(a));
    if (!gold.length) return { zone: "ts", why: "ood" };
    return { zone: "gold", arm: gold[Math.floor(rng() * gold.length) % gold.length] };
  }
  // Exploration budget. Without it the adequate set freezes: a new arm never
  // earns neighbourhood evidence, so it can never enter the set (rich-get-richer).
  if (rng() < (cfg.eps ?? 0.1)) return { zone: "ts", why: "eps" };
  const healthy = ok ? nb.stats.filter((s) => ok(s.arm)) : nb.stats;
  const arm = pickVec(healthy, cfg.adequacyFloor ?? 0.82, cw, !nb.sharp);
  // "inadequate" conflates under-evidenced with unhealthy-when-ok-is-supplied;
  // the caller knows `ok` and can split them if it ever needs to.
  return arm ? { zone: "vec", arm } : { zone: "ts", why: "inadequate" };
}

export class AutoVec {
  enabled = false;
  /** true when cfg.live — server wires autoLlm.route only in live mode. */
  readonly cfgLive = false;
  private cfg: VecCfg = {};
  private dead = false;
  private dim = 384;
  private cap = 0;
  private vecs = new Float32Array(0);
  private results: VecResult[] = [];
  /** per-row embedding identity, parallel to results (see VecStore) */
  private dupId = new Int32Array(0);
  private dupIndex = new Map<string, number>();
  private prior = new Map<string, { a: number; b: number }>();
  private pipe: Promise<unknown> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private verbose = 0;

  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    try {
      this.cfg = JSON.parse(readFileSync(join(dir, "deploy", "auto-vec.json"), "utf8")) as VecCfg;
    } catch { return; } // no config → shadow off
    this.enabled = !!(this.cfg.shadow || this.cfg.live);
    (this as { cfgLive: boolean }).cfgLive = !!this.cfg.live;
    if (!this.enabled) return;
    this.verbose = this.cfg.verboseNext ?? 0;
    this.load();
  }

  private path(p?: string): string { return join(this.dir, p ?? ""); }

  private store(): VecStore {
    return { dim: this.dim, vecs: this.vecs, results: this.results, dupId: this.dupId };
  }

  private nbOpts(rng: () => number): NbOpts {
    return {
      rng, perArm: this.cfg.perArm ?? 16, k: this.cfg.k ?? 50,
      simFloor: this.cfg.simFloor ?? 0.55, nEffFloor: this.cfg.nEffFloor ?? 30,
      sharpFloor: this.cfg.sharpFloor ?? 0.9, priorWeight: this.cfg.priorWeight ?? 0.013,
      distEps: this.cfg.distEps ?? 0.05, riskZ: this.cfg.riskZ ?? 1.64,
    };
  }

  private load(): void {
    try {
      const lines = readFileSync(this.path(this.cfg.storeFile), "utf8").trim();
      this.results = lines ? lines.split("\n").map((l) => JSON.parse(l) as VecResult) : [];
      const bin = readFileSync(this.path(this.cfg.binFile));
      // dim was previously INFERRED as byteLength/4/rows. append() writes the
      // bin before the jsonl, so a crash between them desyncs the two, the
      // inferred dim goes wrong, and every similarity silently becomes NaN
      // with nothing logged (spec s18). The sidecar makes dim explicit and a
      // size mismatch is a hard refusal, not a quiet corruption.
      let meta: { dim?: number; rows?: number } = {};
      try { meta = JSON.parse(readFileSync(this.path(this.cfg.metaFile ?? "deploy/vec-store.meta.json"), "utf8")); } catch { /* first run */ }
      const dim = meta.dim;
      const okMeta = !!dim && meta.rows === this.results.length && bin.byteLength === this.results.length * dim * 4;
      const inferred = this.results.length ? bin.byteLength / 4 / this.results.length : 0;
      const useDim = okMeta ? dim! : (Number.isInteger(inferred) && inferred > 0 ? inferred : 0);
      if (this.results.length && useDim && bin.byteLength === this.results.length * useDim * 4) {
        const ab = new ArrayBuffer(bin.byteLength);
        new Uint8Array(ab).set(bin);
        this.dim = useDim;
        this.vecs = new Float32Array(ab);
        this.cap = this.results.length;
        this.rebuildDupIds();
      } else if (this.results.length || bin.byteLength) {
        // Refuse rather than guess: a wrong dim makes every later similarity
        // NaN, which fails closed but silently and forever.
        this.results = []; this.vecs = new Float32Array(0); this.cap = 0;
        this.dim = 384; this.dupId = new Int32Array(0); this.dupIndex.clear();
        appendFileSync(this.path(this.cfg.logFile), JSON.stringify({
          ts: Date.now(), mode: "store-refused",
          reason: "bin/jsonl/meta disagree on size; started empty rather than infer a wrong dim",
          binBytes: bin.byteLength, rows: meta.rows ?? null, metaDim: dim ?? null,
        }) + "\n");
      }
    } catch { /* fresh store */ }
    try {
      const st = JSON.parse(readFileSync(this.path(this.cfg.priorFile ?? "deploy/ts-state.json"), "utf8")) as Record<string, Record<string, { a?: number; b?: number }>>;
      for (const cls of Object.values(st)) for (const [arm, s] of Object.entries(cls)) {
        const p = this.prior.get(arm) ?? { a: 0, b: 0 };
        p.a += s.a ?? 1; p.b += s.b ?? 1;
        this.prior.set(arm, p);
      }
    } catch { /* no prior yet */ }
  }

  /** Assign each row the id of its distinct embedding. O(n·dim) once at load,
   *  not per lookup. */
  private rebuildDupIds(): void {
    const n = this.results.length;
    this.dupId = new Int32Array(n);
    this.dupIndex.clear();
    for (let r = 0; r < n; r++) {
      const key = vecId(this.vecs, r * this.dim, this.dim);
      let id = this.dupIndex.get(key);
      if (id === undefined) { id = this.dupIndex.size; this.dupIndex.set(key, id); }
      this.dupId[r] = id;
    }
  }

  /** Shadow hook: fire-and-forget, never throws, never routes. Only clean
   *  verdicts count — "served" (approve) is adequacy evidence, "served-heal"
   *  (edited) is not; judge-down fail-open turns store nothing. */
  observe(entry: ObserveEntry, text: string): void {
    if (!this.enabled || this.dead || !text?.trim() || !entry?.model) return;
    // No mode censor. Filtering to served/served-heal discarded every judged
    // non-approve turn (corrected, comment-overruled, correction-failed) — the
    // only rows that separate arms — leaving ok 98.2% true, i.e. 1.8% signal.
    // Availability stays excluded via `down`: it carries no quality evidence.
    if (entry.down) return;
    this.chain = this.chain.then(() => this.step(entry, text)).catch(() => {});
  }

  /** Live steering pick (phase 2): embed the turn, k-NN, decide the zone.
   *  Returns the ts zone too (with `why`) so the caller can log WHY it abstained;
   *  null means only "inert" — no live flag, dead embedder, or empty store.
   *  Fails open to class TS on every error: routing must never 500 a turn. */
  async route(text: string, ok?: (arm: string) => boolean, rng: () => number = Math.random): Promise<RouteZone | null> {
    if (!this.cfg.live || this.dead || !this.results.length || !text?.trim()) return null;
    try {
      const emb = await this.embed(sliceText(text));
      const nb = neighborhood(emb, this.store(), this.prior, this.nbOpts(rng));
      return routeZone(nb, this.cfg, rng, ok, this.costW());
    } catch { return null; }
  }

  /** Tie-break cost model, built from the store's OWN realized rows so shadow and
   *  live price a tie identically — one implementation, both paths. `money` is the
   *  arm's $/1M price: per-turn token counts do not exist (usage chunks are dropped
   *  upstream), so price is the only money signal and cw is a RELATIVE ranking,
   *  which is all a [0.25,4] draw multiplier needs. An arm with no rows is filled
   *  with the WORST observed price and latency, not a neutral one — new models
   *  start pessimistic on cost (spec Amendment 2). Undefined when there is nothing
   *  to rank against, which leaves pickVec quality-only. */
  private costW(): ((arm: string) => number) | undefined {
    const msOf: Record<string, number[]> = {};
    const pxOf: Record<string, number> = {};
    for (const r of this.results) {
      if (r.ms && r.ms > 0) (msOf[r.arm] ??= []).push(r.ms);
      if (r.px && r.px > 0) pxOf[r.arm] = r.px;
    }
    const known = Object.keys(msOf).filter((a) => pxOf[a]);
    if (known.length < 2) return undefined;
    const med = { money: median(known.map((a) => pxOf[a])), ms: median(known.map((a) => median(msOf[a]))) };
    if (!(med.money > 0) || !(med.ms > 0)) return undefined;
    const worstPx = Math.max(...known.map((a) => pxOf[a]));
    const worstMs = Math.max(...known.map((a) => median(msOf[a])));
    return (arm: string) => turnCostWeight(
      pxOf[arm] ?? worstPx, median(msOf[arm] ?? []) || worstMs, med, COST_ALPHA, STALL_USD_PER_MIN,
    );
  }

  private async step(entry: ObserveEntry, text: string): Promise<void> {
    let emb: Float32Array;
    try {
      emb = await this.embed(sliceText(text));
    } catch (e) {
      this.dead = true; // ponytail: one shot at init; restart resets. Retry storms cost more than a dead shadow.
      appendFileSync(this.path(this.cfg.logFile), JSON.stringify({ ts: Date.now(), mode: "dead", error: String(e) }) + "\n");
      return;
    }
    const rng = Math.random;
    const vb = this.verbose-- > 0; // fat lines while the window lasts: which gate, sims, all arm posteriors
    const nb = this.results.length
      ? neighborhood(emb, this.store(), this.prior, this.nbOpts(rng))
      : { nEff: 0, sim: 0, best: 0, sharp: false, stats: [] as ArmStat[], topSims: [] as number[], arms: 0 };
    const rec: VecResult = {
      i: this.results.length, ts: Date.now(), arm: entry.model,
      ok: entry.mode === "served", md: entry.mode,
      ...(entry.ruling !== undefined ? { r: entry.ruling } : {}),
      ...(entry.ms !== undefined ? { ms: entry.ms } : {}),
      ...(entry.px !== undefined ? { px: entry.px } : {}),
    };
    this.append(emb, rec);
    // The shadow must cross the SAME seam live routing will. routeZone is the
    // only implementation of the decision; the inline formula this replaces
    // required nb.sharp, but routeZone passes !nb.sharp as TIE-MODE, so it logged
    // would:null on turns live would actually steer — 17 of the first 30
    // uncensored prod lines. Every pick-rate reported before this fix (including
    // spec Amendment 1's 0.3%) measured that stale copy, not the deployed policy.
    // cw comes from costW() — the same function live uses, so a tie is priced
    // identically in shadow and in production. `ok` stays undefined by nature:
    // a shadow row is HISTORY and health is NOW, so `would` remains an UPPER
    // BOUND — live may reject an arm that has since gone unhealthy.
    const z = routeZone(nb, this.cfg, rng, undefined, this.costW());
    const would = z.zone === "ts" ? null : z.arm;
    const why = z.zone === "ts" ? z.why : null;
    const r3 = (x: number) => +x.toFixed(3);
    const line: Record<string, unknown> = {
      ts: rec.ts, arm: rec.arm, ok: rec.ok, md: rec.md, r: rec.r, ms: rec.ms, px: rec.px,
      sim: r3(nb.sim), nEff: +nb.nEff.toFixed(2),
      best: r3(nb.best), sharp: nb.sharp, zone: z.zone, why, would, agree: would === rec.arm,
      top: nb.stats.slice(0, 5).map((s) => ({ arm: s.arm, mean: r3(s.mean), lcb: r3(s.lcb) })),
    };
    if (vb) {
      const simFloor = this.cfg.simFloor ?? 0.55, nEffFloor = this.cfg.nEffFloor ?? 30, sharpFloor = this.cfg.sharpFloor ?? 0.9;
      line.v = 1;
      line.n = this.results.length;
      line.k = this.cfg.k ?? 50;
      line.gateFail = !nb.sharp ? (nb.sim < simFloor ? "match" : nb.nEff < nEffFloor ? "nEff" : "sharp") : null;
      line.sims = nb.topSims.slice(0, 10).map(r3);
      line.arms = nb.stats.map((s) => ({ arm: s.arm, a: +s.a.toFixed(2), b: +s.b.toFixed(2), mean: r3(s.mean) }));
      // no raw text at rest (2026-09-11 constraint): one-way 16-hex sha prefix; correlate with auto-llm.log by ts
      line.sha = createHash("sha256").update(text).digest("hex").slice(0, 16);
      line.chars = text.length;
    }
    appendFileSync(this.path(this.cfg.logFile), JSON.stringify(line) + "\n");
  }

  private append(v: Float32Array, rec: VecResult): void {
    if (this.results.length === 0) this.dim = v.length;
    // FIFO (spec s17): at the cap, drop the oldest half and rewrite once —
    // amortised O(1) instead of a 154 MB rewrite per row.
    const maxRows = this.cfg.maxRows ?? 100_000;
    if (this.results.length >= maxRows) this.compact(Math.floor(maxRows / 2));
    if (this.results.length >= this.cap) {
      this.cap = Math.max(4096, this.cap * 2);
      const nv = new Float32Array(this.cap * this.dim);
      nv.set(this.vecs.subarray(0, this.results.length * this.dim));
      this.vecs = nv;
      const nd = new Int32Array(this.cap);
      nd.set(this.dupId.subarray(0, this.results.length));
      this.dupId = nd;
    }
    this.vecs.set(v, this.results.length * this.dim);
    const key = vecId(this.vecs, this.results.length * this.dim, this.dim);
    let id = this.dupIndex.get(key);
    if (id === undefined) { id = this.dupIndex.size; this.dupIndex.set(key, id); }
    this.dupId[this.results.length] = id;
    this.results.push(rec);
    appendFileSync(this.path(this.cfg.binFile), Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    appendFileSync(this.path(this.cfg.storeFile), JSON.stringify(rec) + "\n");
    this.writeMeta();
  }

  private writeMeta(): void {
    writeFileSync(this.path(this.cfg.metaFile ?? "deploy/vec-store.meta.json"),
      JSON.stringify({ dim: this.dim, rows: this.results.length }));
  }

  /** Rewrite both files keeping only the newest `keep` rows. */
  private compact(keep: number): void {
    const drop = this.results.length - keep;
    if (drop <= 0) return;
    this.results = this.results.slice(drop);
    const nv = new Float32Array(Math.max(4096, keep * 2) * this.dim);
    nv.set(this.vecs.subarray(drop * this.dim, (drop + keep) * this.dim));
    this.vecs = nv;
    this.cap = Math.max(4096, keep * 2);
    this.rebuildDupIds();
    writeFileSync(this.path(this.cfg.binFile), Buffer.from(this.vecs.buffer, 0, keep * this.dim * 4));
    writeFileSync(this.path(this.cfg.storeFile), this.results.map((r) => JSON.stringify(r)).join("\n") + "\n");
    this.writeMeta();
    appendFileSync(this.path(this.cfg.logFile), JSON.stringify({ ts: Date.now(), mode: "compact", dropped: drop, rows: keep }) + "\n");
  }

  private async embed(text: string): Promise<Float32Array> {
    if (!this.pipe) this.pipe = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = join(this.dir, "deploy", "emb-cache");
      return pipeline("feature-extraction", this.cfg.model ?? "Xenova/bge-small-en-v1.5", { dtype: "q8" });
    })();
    const pipe = (await this.pipe) as unknown as (t: string, o: { pooling: string; normalize: boolean }) => Promise<Array<{ data: Float32Array }>>;
    const out = await pipe(text, { pooling: "mean", normalize: true });
    return out[0].data;
  }
}

export const autoVec = new AutoVec(import.meta.dirname);