import { test } from "node:test";
import assert from "node:assert/strict";
import { makeItem, score } from "./fwe.ts";
import { parseTally, chunkWords, CHUNK_WORDS } from "./fwecensus.ts";

test("parseTally reads word: count lines and ignores filler", () => {
  const t = parseTally("Here are the counts:\nka: 12\nmi = 3\nnot a tally line\nra: 7\n");
  assert.deepEqual(t, { ka: 12, mi: 3, ra: 7 });
});

test("chunkWords covers every token exactly once", () => {
  const toks = Array.from({ length: 250 }, (_, i) => `w${i}`);
  const cs = chunkWords(toks, 60);
  assert.equal(cs.length, 5);
  assert.deepEqual(cs.flat(), toks);
});

test("chunk stays under the 32k cap at 128K words", () => {
  const item = makeItem(1, 128000);
  const toks = item.prompt.split("\n\n")[1].split(" ");
  for (const c of chunkWords(toks)) assert.ok(c.length <= CHUNK_WORDS);
});

// The whole thesis in one assertion: per-chunk tallies summed IN CODE must
// recover the true top-3, even though no single chunk sees the full stream.
test("perfect per-chunk counting sums to the right answer", () => {
  const item = makeItem(3, 20000);
  const total: Record<string, number> = {};
  for (const c of chunkWords(item.prompt.split("\n\n")[1].split(" "))) {
    for (const w of c) total[w] = (total[w] ?? 0) + 1; // stand-in for a perfect model
  }
  const top = Object.entries(total).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  assert.equal(score(top.join(","), item.answer), 1);
});

// r70: the first-character strip repair must undo truncation WITHOUT inventing
// a right answer. If this test ever passes on the "wrong" case, the repair has
// become a scorer that helps the baseline cheat.
test("head repair fixes a stripped char but never rescues a wrong word", () => {
  const answer = ["sara", "lokata", "luzera"];
  const repair = (words: string[]) => {
    const head = words[0]?.toLowerCase();
    if (head && !answer.includes(head)) {
      const fix = answer.find((v) => v.length === head.length + 1 && v.endsWith(head));
      if (fix) words[0] = fix;
    }
    return words;
  };
  assert.deepEqual(repair(["ara", "lokata", "luzera"]), ["sara", "lokata", "luzera"]);
  // A genuinely wrong first word has no suffix match: left alone, still scores wrong.
  assert.deepEqual(repair(["mizo", "lokata", "luzera"]), ["mizo", "lokata", "luzera"]);
  // A correct word is untouched.
  assert.deepEqual(repair(["sara", "lokata", "luzera"]), ["sara", "lokata", "luzera"]);
});
