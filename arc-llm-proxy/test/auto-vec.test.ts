// auto-vec unit tests — pure neighborhood/pick/slice primitives (no model download).
// run: node --test test/auto-vec.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sliceText, neighborhood, pickVec, routeZone, vecId, wilsonLcb, qualityOutcome, AutoVec } from "../auto-vec.ts";
import type { ArmStat, VecStore } from "../auto-vec.ts";
import { costWeight, turnCostWeight } from "../auto-llm.ts";

/** ArmStat carrying the REAL Wilson bound, so tests exercise the pessimism
 *  instead of hand-picked lcb values that could drift from the implementation. */
const st = (arm: string, a: number, b: number, extra: Partial<ArmStat> = {}): ArmStat =>
  ({ arm, a, b, mean: a / (a + b), lcb: wilsonLcb(a, b), ...extra });

const lcg = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const near = (x: number, y: number, eps = 0.01) => Math.abs(x - y) < eps;

/** Build a VecStore with real per-row embedding identities. */
const mkStore = (dim: number, v: Float32Array, results: VecResult[]): VecStore => {
  const dupId = new Int32Array(results.length);
  const seen = new Map<string, number>();
  for (let r = 0; r < results.length; r++) {
    const key = vecId(v, r * dim, dim);
    let id = seen.get(key);
    if (id === undefined) { id = seen.size; seen.set(key, id); }
    dupId[r] = id;
  }
  return { dim, vecs: v, results, dupId };
};
type VecResult = { i: number; ts: number; arm: string; ok: boolean; md?: string; r?: string; ms?: number; px?: number };
const nb = (q: Float32Array, s: VecStore, o: Partial<Parameters<typeof neighborhood>[3]> = {}) =>
  neighborhood(q, s, new Map(), { rng: lcg(42), ...o });

// dim-2 store: A(1,0) ok, A(0.99,0.141) ok, B(0.6,0.8) ok, B(-1,0) bad — all unit vectors
const dim = 2;
const vecs = new Float32Array([1, 0, 0.99, 0.14114109, 0.6, 0.8, -1, 0]);
const results: VecResult[] = [
  { i: 0, ts: 1, arm: "A", ok: true },
  { i: 1, ts: 2, arm: "A", ok: true },
  { i: 2, ts: 3, arm: "B", ok: true },
  { i: 3, ts: 4, arm: "B", ok: false },
];
const store = mkStore(dim, vecs, results);
const q = new Float32Array([1, 0]);

test("sliceText keeps short text intact, head+tail for long", () => {
  assert.equal(sliceText("fix the bug in server.ts"), "fix the bug in server.ts");
  const long = "x".repeat(100_000);
  const s = sliceText(long);
  assert.ok(s.length < 3400 && s.includes("…") && s.endsWith("x".repeat(2000)));
});

test("vecId: identical vectors share an id, different vectors do not", () => {
  const v = new Float32Array([1, 0, 1, 0, 0, 1]);
  assert.equal(vecId(v, 0, 2), vecId(v, 2, 2));   // rows 0 and 1 are the same vector
  assert.notEqual(vecId(v, 0, 2), vecId(v, 4, 2)); // row 2 differs
});

test("neighborhood: inverse-distance weights, prior shrinkage, sharp when gates pass", () => {
  // sims 1, 0.99, 0.6, -1 → w = 1/(1-sim+0.05) = 20, 16.667, 2.222, (excluded: sim<0)
  const n = nb(q, store, { simFloor: 0, nEffFloor: 1, sharpFloor: 0.5 });
  assert.ok(near(n.nEff, 20 + 1 / 0.06 + 1 / 0.45));
  // A: two wins (20 + 16.667) plus the Jeffreys floor; no prior entry for A
  assert.ok(near(n.stats[0].a, 20 + 1 / 0.06 + 0.5, 0.02) && n.stats[0].arm === "A");
  assert.ok(near(n.topSims[0], 1) && near(n.topSims[1], 0.99) && near(n.topSims[2], 0.6));
  assert.ok(n.best > 0.5 && n.best <= 1, `A (36.7 wins) should beat B (2.2 wins), got best=${n.best}`);
  assert.equal(n.sharp, true);
  assert.equal(n.arms, 2);
});

test("neighborhood: all-win arm must not saturate Beta into ties (regression)", () => {
  // priorWeight=0.013 with no pseudocount floor gave b0=0.013; gammaSample
  // then returns ~rng()^77 and every draw is exactly 1.0. Measured P(A>B)=0.300
  // — the better-evidenced arm LOST. The Jeffreys floor is the guard.
  for (const pw of [0.013, 0.05, 3]) {
    const n = nb(q, store, { priorWeight: pw, simFloor: 0, nEffFloor: 1, sharpFloor: 0.5 });
    assert.equal(n.stats[0].arm, "A", `priorWeight=${pw} ranked ${n.stats[0].arm} first`);
    for (const s of n.stats) {
      assert.ok(s.b >= 0.5, `priorWeight=${pw} left ${s.arm} at b=${s.b}, below the floor`);
    }
    // A has 36.7 weighted wins and zero losses; B has 2.2 and zero. A must win.
    assert.ok(n.best > 0.5, `priorWeight=${pw} inverted the ranking: best=${n.best}`);
  }
});

test("neighborhood: distant query → no evidence, match gate trips", () => {
  const qFar = new Float32Array([0, -1]);
  const n = nb(qFar, store, { simFloor: 0.5, nEffFloor: 1, sharpFloor: 0.5 });
  assert.equal(n.sharp, false);   // mean top-k sim ≈ -0.2 < 0.5
  assert.equal(n.stats.length, 0); // every row below the row-level floor → no evidence
});

test("neighborhood: row-level floor blocks nEff inflation from irrelevant rows", () => {
  // 3 arms x 2 antithetical rows each. Without a row-level floor the inverse
  // distance kernel would hand each row w≈0.49 and nEff would look like
  // evidence; the gate must certify nothing here.
  const v = new Float32Array([-1, 0, -1, 0, 0, -1, 0, -1, -0.6, -0.8, -0.6, -0.8]);
  const rs: VecResult[] = [0, 1, 2, 3, 4, 5].map((i) => ({ i, ts: i, arm: "XYZ"[i / 2 | 0], ok: true }));
  const n = nb(q, mkStore(2, v, rs), { simFloor: 0.5, nEffFloor: 1, sharpFloor: 0.5 });
  assert.equal(n.nEff, 0);
  assert.equal(n.sharp, false);
});

test("neighborhood: exact-duplicate rows buy no extra confidence (spec s4)", () => {
  // The live store is 95.6% duplicates; one 26-char prompt was served 57x and
  // used to buy nEff=50. Three identical vectors must count as one.
  const v = new Float32Array([1, 0, 1, 0, 1, 0]);
  const rs: VecResult[] = [0, 1, 2].map((i) => ({ i, ts: i, arm: "A", ok: true }));
  const once = nb(q, mkStore(2, new Float32Array([1, 0]), [{ i: 0, ts: 0, arm: "A", ok: true }]),
    { simFloor: 0, nEffFloor: 1, sharpFloor: 0.5 });
  const thrice = nb(q, mkStore(2, v, rs), { simFloor: 0, nEffFloor: 1, sharpFloor: 0.5 });
  assert.ok(near(once.nEff, 20));
  assert.ok(near(thrice.nEff, once.nEff), `3 duplicates gave nEff ${thrice.nEff}, expected ${once.nEff}`);
});

test("neighborhood: per-arm retrieval keeps a rare arm visible (spec s2)", () => {
  // D dominates at sim≈1 (5 distinct rows); R sits at sim 0.8 with one win and
  // one loss. A global top-3 would return only D. Per-arm must return both.
  const d = [0, 2, 4, 6, 8].map((deg) => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)]);
  const flat: number[] = [];
  for (const [x, y] of d) flat.push(x, y);
  flat.push(0.8, 0.6, 0.8, -0.6);
  const rs: VecResult[] = [
    ...d.map((_, i) => ({ i, ts: i, arm: "D", ok: true })),
    { i: 5, ts: 5, arm: "R", ok: true },
    { i: 6, ts: 6, arm: "R", ok: false },
  ];
  const n = nb(q, mkStore(2, new Float32Array(flat), rs), { perArm: 16, k: 3, simFloor: 0.5, nEffFloor: 1, sharpFloor: 0.5 });
  assert.equal(n.arms, 2);
  assert.deepEqual(n.stats.map((s) => s.arm).sort(), ["D", "R"]);
  assert.ok(n.stats.find((s) => s.arm === "R")!.mean < 0.6, "R's loss must be visible, not washed out");
});

test("neighborhood: priorWeight is a hint, not a verdict (spec s6)", () => {
  const pooled = { a: 1061, b: 235 };            // the live mimo-v2.5 prior
  const prior = new Map([["B", pooled]]);
  const o = { rng: lcg(1), simFloor: 0, nEffFloor: 1, sharpFloor: 0.5 };
  const light = neighborhood(q, store, prior, { ...o, priorWeight: 0.013 });
  const heavy = neighborhood(q, store, prior, { ...o, priorWeight: 3 });
  const bLight = light.stats.find((s) => s.arm === "B")!;
  const bHeavy = heavy.stats.find((s) => s.arm === "B")!;
  const pooledMean = pooled.a / (pooled.a + pooled.b);
  // B's only local evidence is one win (w=2.222, no losses), so a light prior
  // must let that pull B above its pooled mean...
  assert.ok(bLight.mean > pooledMean, `priorWeight=0.013 pinned B at ${bLight.mean} <= pooled ${pooledMean}`);
  // ...and a heavy prior must make the local evidence irrelevant.
  assert.ok(near(bHeavy.mean, pooledMean, 0.001), `priorWeight=3 gave ${bHeavy.mean}, expected ~${pooledMean}`);
  assert.ok(Math.abs(bLight.mean - pooledMean) > Math.abs(bHeavy.mean - pooledMean) * 10,
    "light prior must move the estimate far more than heavy prior");
});

test("neighborhood: gates and empty store", () => {
  assert.equal(nb(q, store, { simFloor: 0, nEffFloor: 1, sharpFloor: 0.999 }).sharp, false);
  assert.equal(nb(q, store, { simFloor: 0, nEffFloor: 1e6, sharpFloor: 0.5 }).sharp, false); // nEff unreachable
  const empty = nb(q, mkStore(2, new Float32Array(0), []), { simFloor: 0, nEffFloor: 0, sharpFloor: 0.5 });
  assert.equal(empty.sharp, false);
  assert.equal(empty.arms, 0);
});

test("pickVec: strongest adequate arm, null when none adequate", () => {
  const stats = [st("m1", 98, 2), st("m2", 90, 10), st("m3", 1, 1)];
  assert.equal(pickVec(stats, 0.9), "m1");   // only m1's bound clears 0.9
  assert.equal(pickVec(stats, 0.95), null);  // nothing does
  assert.equal(pickVec([], 0.9), null);
});

test("pickVec: cost decides when quality is tied, quality leads when it separates", () => {
  // A: best quality, pricier. B: adequate (exactly at the floor) but cheaper.
  // C: cheapest of all, but below the adequacy floor -> must NEVER win, at any
  // price. That floor is the only hard quality guard, so it has to hold.
  const stats: ArmStat[] = [st("A", 98, 2), st("B", 90, 10), st("C", 40, 60)];
  const cw = (a: string) => ({ A: 1.0, B: 1.05, C: 9 }[a] ?? 1);
  assert.equal(pickVec(stats, 0.8), "A");                    // no cost fn -> bound order
  assert.equal(pickVec(stats, 0.8, cw, true), "B");          // tied -> cheapest adequate
  assert.equal(pickVec(stats, 0.8, cw, false), "A");         // sharp -> quality still leads
  assert.equal(pickVec(stats, 0.95, cw, true), null);        // nothing clears -> abstain
  assert.equal(pickVec(stats, 0.3, cw, true), "C");          // floor lowered -> cheap wins
  assert.equal(pickVec([], 0.9, cw, true), null);
});

test("pickVec: an unverified arm cannot win a tie on price (Wilson bound)", () => {
  // Live-fleet failure this guards: money-only routing sent 75% of turns to an
  // arm backed by 8 rows. Exploiting an arm whose failures were never observed
  // is the expensive mistake — a response that derails the session or causes
  // material loss costs orders of magnitude more than the price gap that made
  // the arm look attractive. Ranking and gating on the pessimistic bound prices
  // that risk from the evidence already in hand, so no count threshold and no
  // invented dollar figure is needed. Same mean, different evidence:
  const stats: ArmStat[] = [st("LOTTERY", 9, 0.5), st("PROVEN", 95, 5)];
  const cw = (a: string) => (a === "LOTTERY" ? 4 : 1);
  assert.ok(stats[0].mean > 0.94 && stats[1].mean < 0.96, "means are ~equal");
  assert.ok(stats[0].lcb < 0.9, "barely-seen arm is NOT verified");
  assert.ok(stats[1].lcb >= 0.9, "well-seen arm IS verified");
  assert.equal(pickVec(stats, 0.9, cw, true), "PROVEN");   // 4x cheaper still cannot win
  assert.equal(pickVec(stats, 0.65, cw, true), "LOTTERY"); // both verified enough -> price rules
  // quality-led selection ranks on the same bound, so evidence still wins
  assert.equal(pickVec(stats, 0.65, (a) => (a === "PROVEN" ? 4 : 1), false), "PROVEN");
  // nothing verified enough -> abstain rather than exploit an unknown
  assert.equal(pickVec([stats[0]], 0.9, cw, true), null);
  // the bound is the hidden-cost knob: more z, more demanded evidence
  assert.ok(wilsonLcb(9, 0.5, 2.33) < wilsonLcb(9, 0.5, 1.64));
  assert.equal(wilsonLcb(0, 0), 0);
  // The shipped default (0.82) is on the BOUND scale, not the mean scale. A
  // mean-calibrated 0.9 would bar every arm at current evidence volumes: even a
  // flawless arm needs n>=25, and the realistic n~33 arm at p=0.98 bounds at
  // 0.891. Pinned so the scale cannot silently drift back.
  assert.ok(wilsonLcb(0.98 * 33, 0.02 * 33) < 0.9, "0.9 on the bound is unreachable");
  assert.ok(wilsonLcb(0.98 * 33, 0.02 * 33) >= 0.82, "0.82 admits a good arm at n~33");
  assert.ok(wilsonLcb(9, 0) < 0.82, "8 lucky rows are still barred by the default");
});

test("turnCostWeight: time must be priced or the cheapest-per-token arm wins", () => {
  // Real live-fleet numbers. Ling-VL is 2.8x cheaper per token than ds-v4-flash
  // but 2.1x slower, and at $0.50/min wall time is 96% of its turn cost.
  const med = { money: 0.065, ms: 19242 };
  const A = 0.5, STALL = 0.5;
  const slow = { money: 0.013, ms: 33586 };   // Ling-3.0-flash-VL
  const fast = { money: 0.037, ms: 16311 };   // deepseek-v4-flash
  // money-only ranking picks the slow arm...
  assert.ok(costWeight(slow.money, med.money, A) > costWeight(fast.money, med.money, A));
  // ...total-cost ranking correctly picks the fast one. This inversion is the
  // whole reason turnCostWeight exists.
  assert.ok(turnCostWeight(slow.money, slow.ms, med, A, STALL) < turnCostWeight(fast.money, fast.ms, med, A, STALL));
  // clamped to the same [0.25, 4] band as costWeight
  assert.equal(turnCostWeight(1e-9, 1, med, A, STALL), 4);
  assert.equal(turnCostWeight(1e6, 1e9, med, A, STALL), 0.25);
  // unknown measurements -> neutral 1, never a guessed price
  assert.equal(turnCostWeight(undefined, 100, med, A, STALL), 1);
  assert.equal(turnCostWeight(0.05, undefined, med, A, STALL), 1);
  assert.equal(turnCostWeight(0.05, 100, { money: 0, ms: 0 }, A, STALL), 1);
  assert.equal(turnCostWeight(0.05, 100, med, 0, STALL), 1);
  // stall rate is the knob: at $0/min this reduces to money-only ordering
  assert.ok(turnCostWeight(slow.money, slow.ms, med, A, 0) > turnCostWeight(fast.money, fast.ms, med, A, 0));
});

test("routeZone: quality tie routes to the cheap arm instead of abstaining", () => {
  const stats: ArmStat[] = [st("A", 980, 20), st("B", 950, 50)];
  const nb = (o: { sim?: number; sharp?: boolean; stats?: ArmStat[] } = {}) => ({
    nEff: 40, sim: o.sim ?? 0.9, best: 0.95, sharp: o.sharp ?? true,
    stats: o.stats ?? [st("A", 98, 2)],
  });
  const cfg = { simFloor: 0.55, adequacyFloor: 0.9, eps: 0.1, gold: ["G1", "G2"] };
  const cw = (a: string) => (a === "B" ? 1.005 : 1.0);
  const hi = () => 0.99; // dice >= eps -> use the neighbourhood
  const lo = () => 0.0;  // dice <  eps -> explore via class TS

  // THE point of the change: sharp=false used to abstain to class TS. On an easy
  // turn the judge cannot separate competent arms, so abstaining throws away a
  // free saving. Quality-tied must route to the cheapest adequate arm.
  assert.deepEqual(routeZone(nb({ sharp: false, stats }), cfg, hi, undefined, cw), { zone: "vec", arm: "B" });
  // quality separates -> the better arm still wins despite costing more
  assert.deepEqual(routeZone(nb({ sharp: true, stats }), cfg, hi, undefined, cw), { zone: "vec", arm: "A" });
  // the eps exploration budget still applies in the tie band, or the adequate
  // set freezes and no new arm can ever enter it
  assert.deepEqual(routeZone(nb({ sharp: false, stats }), cfg, lo, undefined, cw), { zone: "ts", why: "eps" });
  // unhealthy cheapest falls through to NEXT-BEST, not all the way to ts
  assert.deepEqual(routeZone(nb({ sharp: false, stats }), cfg, hi, (a) => a !== "B", cw), { zone: "vec", arm: "A" });
  // every arm unhealthy -> ts
  assert.deepEqual(routeZone(nb({ sharp: false, stats }), cfg, hi, () => false, cw), { zone: "ts", why: "inadequate" });
  // no cost fn at all -> old bound-ordered behaviour, still correct
  assert.deepEqual(routeZone(nb({ sharp: false, stats }), cfg, hi), { zone: "vec", arm: "A" });
  // The trade-off is real and deliberate: quality-led ranking multiplies the
  // bound by the cost weight, so a LARGE price edge does overturn a SMALL
  // quality edge (A .971*1.0 vs B .937*1.25). Same alpha=0.5 house behaviour as
  // betaSample*costWeight in class TS - pinned here so it cannot drift silently.
  const big = (a: string) => (a === "B" ? 1.25 : 1.0);
  assert.deepEqual(routeZone(nb({ sharp: true, stats }), cfg, hi, undefined, big), { zone: "vec", arm: "B" });
});

test("routeZone: OOD → gold, sharp+eps-pass → vec arm, everything else → class TS", () => {
  const nb = (o: { sim?: number; sharp?: boolean; stats?: ArmStat[] } = {}) => ({
    nEff: 40, sim: o.sim ?? 0.9, best: 0.95, sharp: o.sharp ?? true,
    stats: o.stats ?? [st("A", 98, 2)],
  });
  const cfg = { simFloor: 0.55, adequacyFloor: 0.9, eps: 0.1, gold: ["G1", "G2"] };
  const hi = () => 0.99; // dice >= eps → exploit the neighborhood
  const lo = () => 0.0;  // dice <  eps → keep exploring

  // OOD: below the sim floor the pooled-class TS is the cheap-lottery trap, so
  // novel work goes to gold — and eps is NOT rolled (every novel prompt deserves gold)
  assert.equal(routeZone(nb({ sim: 0.1 }), cfg, lo).zone, "gold");
  assert.deepEqual(routeZone(nb({ sim: 0.1 }), cfg, lo, (a) => a === "G2"), { zone: "gold", arm: "G2" });
  // unhealthy gold arms are filtered out; nothing left → fall back to class TS
  assert.deepEqual(routeZone(nb({ sim: 0.1 }), cfg, lo, () => false), { zone: "ts", why: "ood" });
  // sharp + eps-pass → strongest adequate arm from the neighborhood
  assert.deepEqual(routeZone(nb(), cfg, hi), { zone: "vec", arm: "A" });
  // sharp, but a vec arm that is unhealthy right now → class TS, not a doomed pick
  assert.deepEqual(routeZone(nb(), cfg, hi, () => false), { zone: "ts", why: "inadequate" });
  // sharp but the eps dice says explore → class TS (learning must not stop)
  assert.deepEqual(routeZone(nb(), cfg, lo), { zone: "ts", why: "eps" });
  // no arm clears the adequacy floor → class TS
  assert.deepEqual(routeZone(nb({ stats: [st("A", 1, 9)] }), cfg, hi), { zone: "ts", why: "inadequate" });
});

test("auto-vec: the routing decision exists exactly once, so shadow ≡ live", () => {
  const src = readFileSync(new URL("../auto-vec.ts", import.meta.url), "utf8");
  // The shadow logger must cross the same seam live routing will. It once carried
  // its own inline formula (`nb.sharp && roll >= eps ? pickVec(...)`), which
  // disagreed with routeZone — sharp is TIE-MODE there, not a permission gate — so
  // prod shadow lines reported would:null on turns live would actually steer, and
  // every pick-rate quoted from them (including spec Amendment 1's 0.3%) was fiction.
  assert.ok(!/nb\.sharp &&/.test(src),
    "no inline sharp gate: routeZone takes !nb.sharp as TIE-MODE, not a precondition");
  // one definition + one call site (inside routeZone). A second call site means
  // the decision got duplicated again and the shadow no longer measures live.
  assert.equal(src.split("pickVec(").length - 1, 2,
    "pickVec must be defined once and called once, from routeZone");
});

test("AutoVec: absent config → shadow disabled, no throw", () => {
  const v = new AutoVec("/tmp/no-vec-config-here");
  assert.equal(v.enabled, false);
  v.observe({ model: "x/y", mode: "served" }, "text"); // no-op, must not throw
});

test("qualityOutcome: ruling outranks ok; availability rows carry no quality evidence", () => {
  const base = { i: 0, ts: 0, arm: "A" };
  assert.equal(qualityOutcome({ ...base, ok: true }), true);                                   // legacy approve
  assert.equal(qualityOutcome({ ...base, ok: false }), false);                                 // legacy non-approve
  assert.equal(qualityOutcome({ ...base, ok: false, md: "corrected", r: "approve" }), true);    // ruling outranks ok
  assert.equal(qualityOutcome({ ...base, ok: true, md: "corrected", r: "comment" }), false);    // ruling outranks ok
  assert.equal(qualityOutcome({ ...base, ok: false, md: "serve-error" }), undefined);           // availability → excluded
});

test("neighborhood: an availability row is invisible — no beta weight, no perArm slot", () => {
  const judged: VecResult = { i: 1, ts: 2, arm: "A", ok: false, md: "corrected", r: "approve" };
  const down: VecResult = { i: 0, ts: 1, arm: "A", ok: false, md: "serve-error" };
  const qA = new Float32Array([1, 0]);
  const clean = nb(qA, mkStore(2, new Float32Array([0.99, 0.14114109]), [judged]), { perArm: 1 });
  // the availability row is CLOSER to q, so if it were beta material or took the
  // single perArm slot it would displace the judged row and change the posterior.
  const dirty = nb(qA, mkStore(2, new Float32Array([1, 0, 0.99, 0.14114109]), [down, judged]), { perArm: 1 });
  assert.deepEqual(dirty.stats, clean.stats);
  assert.equal(dirty.nEff, clean.nEff);
  assert.ok(clean.stats[0].a > clean.stats[0].b, "the judged approve row is the evidence");
});

test("neighborhood: a judged comment row IS beta material (the uncensored signal)", () => {
  const approve: VecResult = { i: 0, ts: 1, arm: "A", ok: true, md: "served", r: "approve" };
  const comment: VecResult = { i: 1, ts: 2, arm: "A", ok: false, md: "corrected", r: "comment" };
  const qA = new Float32Array([1, 0]);
  const allOk = nb(qA, mkStore(2, new Float32Array([1, 0]), [approve]), { perArm: 16 });
  const mixed = nb(qA, mkStore(2, new Float32Array([1, 0, 0.99, 0.14114109]), [approve, comment]), { perArm: 16 });
  assert.ok(mixed.stats[0].mean < allOk.stats[0].mean, "a non-approve ruling must lower the arm");
  assert.ok(mixed.stats[0].lcb < allOk.stats[0].lcb, "and lower its pessimistic bound");
});
// ---------- phase-2 cutover: cost model + route contract ----------

const vecSrc = () => readFileSync(new URL("../auto-vec.ts", import.meta.url), "utf8");

/** An AutoVec with hand-set rows — costW reads this.results, nothing else. */
function rows(r: Array<{ arm: string; ms?: number; px?: number }>): AutoVec {
  const av = new AutoVec("/tmp/no-such-vec-dir-xyz");
  (av as unknown as { results: unknown[] }).results = r.map((x, i) => ({ i, ts: 0, ok: true, ...x }));
  return av;
}

test("costW: prices money + wall time, and an unmeasured arm starts pessimistic", () => {
  const cw = (rows([
    { arm: "cheap/fast", ms: 5_000, px: 0.2 }, { arm: "cheap/fast", ms: 6_000, px: 0.2 },
    { arm: "pricey/slow", ms: 60_000, px: 4.0 }, { arm: "pricey/slow", ms: 70_000, px: 4.0 },
  ]) as unknown as { costW(): (a: string) => number }).costW();
  assert.ok(cw, "two priced+timed arms are enough to rank");
  assert.ok(cw("cheap/fast") > cw("pricey/slow"), "cheaper AND faster must draw higher");
  assert.equal(cw("never/seen"), cw("pricey/slow"), "an unmeasured arm inherits the WORST observed cost, not a neutral one");
  for (const a of ["cheap/fast", "pricey/slow", "never/seen"]) {
    assert.ok(cw(a) >= 0.25 && cw(a) <= 4, `${a} escaped the [0.25,4] clamp: ${cw(a)}`);
  }
});

test("costW: undefined unless at least two arms have BOTH ms and px", () => {
  const one = rows([{ arm: "solo", ms: 5_000, px: 0.2 }]) as unknown as { costW(): unknown };
  assert.equal(one.costW(), undefined, "nothing to rank against -> quality-only pickVec");
  const split = rows([{ arm: "a", ms: 5_000 }, { arm: "b", px: 1 }]) as unknown as { costW(): unknown };
  assert.equal(split.costW(), undefined, "time without price (or price without time) is not a cost");
});

test("costW: a slow-but-cheap arm is not automatically the winner (time is priced)", () => {
  const cw = (rows([
    { arm: "fast/pricey", ms: 4_000, px: 1.0 }, { arm: "fast/pricey", ms: 4_000, px: 1.0 },
    { arm: "slow/cheap", ms: 300_000, px: 0.1 }, { arm: "slow/cheap", ms: 300_000, px: 0.1 },
  ]) as unknown as { costW(): (a: string) => number }).costW();
  // 300s at $0.50/min = $2.50 of stall, dwarfing the $0.90 token-price gap.
  assert.ok(cw("fast/pricey") > cw("slow/cheap"),
    `wall time must dominate a small price gap: fast=${cw("fast/pricey")} slow=${cw("slow/cheap")}`);
});

test("route(): inert without live:true — null, and no embedding is bought", async () => {
  const av = new AutoVec("/tmp/no-such-vec-dir-xyz");
  let embedded = false;
  (av as unknown as { embed: (t: string) => Promise<Float32Array> }).embed = async () => { embedded = true; return new Float32Array(4); };
  (av as unknown as { results: unknown[] }).results = [{ i: 0, ts: 0, arm: "a", ok: true }];
  assert.equal(await av.route("hello"), null);
  assert.equal(embedded, false, "the revert flag must make routing free, not just ignored");
});

test("guard: one cost model for shadow and live; routeZone stays the only decision", () => {
  const src = vecSrc();
  assert.equal((src.match(/routeZone\(/g) ?? []).length, 3, "routeZone: 1 definition + exactly 2 call sites (step + route)");
  assert.equal((src.match(/this\.costW\(\)/g) ?? []).length, 2, "both call sites must price ties with the same costW");
  assert.equal((src.match(/private costW\(/g) ?? []).length, 1, "costW has one definition");
  const body = src.slice(src.indexOf("async route("), src.indexOf("private costW("));
  assert.match(body, /return routeZone\(/, "route must return routeZone's verdict verbatim");
  assert.ok(!/zone === "ts" \? null/.test(body), "collapsing ts to null hides the abstain reason from the live log");
});
