import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTask, scoreTask, countError, wilson, isBillingCaused } from "./task.ts";

test("ground truth matches the corpus", () => {
  for (const seed of [1, 5, 77]) {
    const t = makeTask(seed, 200);
    // Derived from BILLING_CAUSE, not a duplicated literal: r43 added boundary
    // phrasings and a hardcoded regex silently went stale against them.
    const actual = t.units.filter(isBillingCaused).length;
    assert.equal(t.answer, actual, `seed ${seed}`);
  }
});

test("naive keyword matching on 'billing' overcounts — distractors bite", () => {
  const t = makeTask(3, 300);
  const naive = t.units.filter((u) => /billing|invoice|charge|payment/i.test(u)).length;
  assert.ok(
    naive > t.answer,
    `keyword match ${naive} should exceed truth ${t.answer}; distractors are not working`,
  );
});

test("every unit is independently classifiable", () => {
  const t = makeTask(9, 50);
  assert.equal(t.units.length, 50);
  for (const u of t.units) assert.match(u, /^Ticket #\d+\n/);
});

test("answer is a meaningful fraction, not degenerate", () => {
  const t = makeTask(11, 400);
  assert.ok(t.answer > 40 && t.answer < 160, `got ${t.answer}/400`);
});

test("scoring takes the final integer and is exact", () => {
  assert.equal(scoreTask("17", 17), 1);
  assert.equal(scoreTask("Counting through: 3, 9, then 17", 17), 1);
  assert.equal(scoreTask("16", 17), 0);
  assert.equal(scoreTask("no idea", 17), 0);
});

test("countError is smooth, bounded, and worst-case on garbage", () => {
  assert.equal(countError("12", 12), 0);
  assert.equal(countError("11", 12), 1 / 12);
  assert.equal(countError("6", 12), 0.5);
  assert.equal(countError("0", 12), 1);
  assert.equal(countError("99999", 12), 1, "must clamp, not explode");
  assert.equal(countError("no idea", 12), 1);
});

test("wilson interval brackets the estimate and stays inside [0,1]", () => {
  const [lo, hi] = wilson(3, 3);
  assert.ok(lo > 0.29 && lo < 0.45, `lo ${lo}`);
  assert.equal(hi, 1, "3/3 must not exceed 1");
  // The failure the CI exists to expose: 3/3 is NOT evidence of >99% accuracy.
  assert.ok(lo < 0.5, "3/3 is consistent with a coin flip; CI must say so");
  const [wlo, whi] = wilson(50, 100);
  assert.ok(wlo > 0.39 && whi < 0.61, "n=100 must be far tighter than n=3");
  assert.deepEqual(wilson(0, 0), [0, 1], "no data means no knowledge");
});

test("per-unit truth aligns with units and sums to the answer", () => {
  for (const seed of [1, 7, 99]) {
    const t = makeTask(seed, 40);
    assert.equal(t.truth.length, t.units.length, "truth must be parallel to units");
    assert.equal(
      t.truth.filter(Boolean).length,
      t.answer,
      "a parallel array that disagrees with the total is worse than no array",
    );
    // Alignment, not just cardinality: a shuffled truth array would pass the sum.
    // Checked against BILLING_CAUSE itself — a hand-copied regex drifts from the
    // data it claims to describe, which is how this test failed when first written.
    for (let i = 0; i < t.units.length; i++) {
      const isBilling = isBillingCaused(t.units[i]);
      assert.equal(t.truth[i], isBilling, `unit ${i} truth disagrees with its own text`);
    }
  }
});

test("r52 hard arm: labels stay correct and the near-misses actually appear", () => {
  // The r47 failure was measuring a good model against bad ground truth. The
  // hard arm doubles the cause pools, so check its labels the same way.
  for (const seed of [1, 42]) {
    const t = makeTask(seed, 300, true);
    assert.equal(t.truth.filter(Boolean).length, t.answer);
    for (let i = 0; i < t.units.length; i++) {
      assert.equal(t.truth[i], isBillingCaused(t.units[i]), `unit ${i}`);
    }
  }
  // The arm is pointless if the hard phrasings never get sampled.
  const hard = makeTask(5, 400, true);
  const seen = hard.units.filter((u) => /wrongly flagged as expired|proration error/.test(u));
  assert.ok(seen.length > 0, "hard causes never sampled");
  // And the easy arm must NOT contain them, or the two arms aren't comparable.
  const easy = makeTask(5, 400, false);
  assert.equal(easy.units.filter((u) => /wrongly flagged as expired/.test(u)).length, 0);
});

test("r52: near-miss pairs are surface-similar, so substring matching cannot separate them", () => {
  // Each hard pair shares an opening clause and differs only in root cause.
  // If a prefix match could split them, the arm isn't testing what it claims.
  const t = makeTask(3, 600, true);
  const downgraded = t.units.filter((u) => u.includes("was downgraded to the free tier"));
  const labels = new Set(downgraded.map(isBillingCaused));
  assert.equal(labels.size, 2, "the shared-prefix pair must appear on BOTH sides");
});
