// ponytail: node:test + assert, no framework.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeItem, score } from "./fwe.ts";

test("planted words are actually the 3 most frequent, in order", () => {
  for (const seed of [1, 2, 3, 42, 99]) {
    const it = makeItem(seed, 2000);
    const body = it.prompt.split("\n\n")[1];
    const counts = new Map<string, number>();
    for (const w of body.split(" ")) counts.set(w, (counts.get(w) ?? 0) + 1);
    const top3 = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
    assert.deepEqual(top3, it.answer, `seed ${seed}`);
  }
});

test("item length tracks the requested word count", () => {
  const it = makeItem(7, 5000);
  assert.equal(it.words, 5000);
});

test("distinct seeds give distinct answers", () => {
  const a = makeItem(1, 2000).answer.join(",");
  const b = makeItem(2, 2000).answer.join(",");
  assert.notEqual(a, b);
});

test("scoring is exact-match, rank-sensitive, and robust to filler", () => {
  const ans = ["kato", "nemi", "rasu"];
  assert.equal(score("kato, nemi, rasu", ans), 1);
  assert.equal(score("The answer is: kato, nemi, rasu.", ans), 1);
  assert.equal(score("kato, rasu, nemi", ans), 1 / 3); // rank matters
  assert.equal(score("zzzz, yyyy, xxxx", ans), 0);
});

test("a wrong word displaces rather than shifts the remaining guesses", () => {
  const ans = ["kato", "nemi", "rasu"];
  // A junk word in slot 1 costs that slot; nemi/rasu keep their true positions
  // and still score. Scoring 1/3 here (only rasu aligned) would mean junk had
  // promoted the rest.
  assert.equal(score("mizu, nemi, rasu", ans), 0);
  // ...but junk in slot 2 leaves slot 1 correct.
  assert.equal(score("kato, mizu, rasu", ans), 2 / 3);
});
