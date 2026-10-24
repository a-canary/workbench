import { test } from "node:test";
import assert from "node:assert/strict";
import { batch, parseVerdicts, TOK_PER_LINE, MAX_LINES, CAP } from "./pipeline.ts";
import { makeTask } from "./task.ts";

// r47 and r50 were both batching defects that reached the scored record because
// nothing exercised batch() directly. These are the two checks that would have
// caught them.

test("r50: a batch never demands more output than one call can emit", () => {
  // The r50 failure: 153 units/batch at 60 tok/line requested 9980 output
  // tokens and the model truncated at ~111 lines. The bound has to hold for the
  // widest batch any budget can produce, not just the ones we happened to run.
  for (const units of [80, 320, 1000]) {
    for (const budget of [4000, 12000, 30000]) {
      const t = makeTask(1000, units);
      for (const b of batch(t.units, budget)) {
        assert.ok(b.length <= MAX_LINES, `batch of ${b.length} exceeds MAX_LINES`);
        assert.ok(
          TOK_PER_LINE * b.length + 800 <= CAP,
          `batch of ${b.length} requests ${TOK_PER_LINE * b.length + 800} output tokens, over the ${CAP} cap`,
        );
      }
    }
  }
});

test("r47: batch width is stable across seeds, not set by one sampled unit", () => {
  // Sizing on units[0] made width swing 9x depending on which sentence happened
  // to land first. Same units and budget must give the same width every seed.
  const widths = [1000, 1001, 1002, 1003].map((s) => batch(makeTask(s, 320).units, 12000)[0].length);
  assert.equal(new Set(widths).size, 1, `width varied across seeds: ${widths.join(",")}`);
});

test("every unit lands in exactly one batch", () => {
  const t = makeTask(7, 320);
  const flat = batch(t.units, 12000).flat();
  assert.equal(flat.length, t.units.length, "units lost or duplicated");
  assert.deepEqual(flat, t.units, "order or content changed");
});

test("parseVerdicts survives the stripped first character", () => {
  // The backend eats the reply's first char; BEGIN is the sacrificial line.
  const reply = "EGIN\n0: avatar upload size limit -> NO\n1: charged twice -> YES";
  const v = parseVerdicts(reply, 2);
  assert.equal(v.size, 2, "both units must parse despite the strip");
  assert.equal(v.get(0), false);
  assert.equal(v.get(1), true);
});

test("parseVerdicts reports a short reply rather than silently undercounting", () => {
  // The r50 shape: a truncated list. Size must be < n so the guard fires —
  // scoring a partial reply as a complete count is the failure r19 exists to stop.
  const truncated = "EGIN\n0: billed twice -> YES\n1: slow page -> NO\n2: refund short ->";
  assert.ok(parseVerdicts(truncated, 10).size < 10);
});

test("out-of-range indices are ignored, not counted", () => {
  // A hallucinated "97:" line in a 3-unit batch must not inflate the total.
  assert.equal(parseVerdicts("EGIN\n0: a -> YES\n97: invented -> YES", 3).size, 1);
});
