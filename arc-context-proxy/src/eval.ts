// Eval harness. Runs a strategy over N seeded tasks, scores exact-match,
// appends one JSONL row per round so rounds are comparable across sessions.
import { appendFileSync } from "node:fs";
import { makeTask, scoreTask, countError, wilson, phrasePoolSize } from "./task.ts";
import { baseline, census } from "./pipeline.ts";
import { makeItem, score } from "./fwe.ts";
import { fweCensus, fweBaseline } from "./fwecensus.ts";

const CAP_MS = 15 * 60 * 1000; // docs/eval.md §0
const LOG = new URL("../metrics.jsonl", import.meta.url).pathname;

export type Result = {
  round: string;
  strategy: string;
  units: number;
  seeds: number;
  score: number; // mean exact-match, 0..1
  hits: number;
  ms: number;
  calls: number;
  errors: number;
  meanCountError: number; // the count-level axis — floor ~8.6pt, see r56
  /**
   * r58: per-unit judgment accuracy, the low-variance axis.
   * countErr takes one sample per seed (12/round); this takes one per UNIT
   * (~960/round) from the SAME calls. r57 showed trials cannot be bought with
   * wall-clock, so the only remaining way to lower the floor is to stop
   * discarding the evidence each call already returns.
   */
  unitAcc: number;
  unitN: number;
  unitCi: [number, number];
  /**
   * r66: unitN counts JUDGMENTS, and judgments repeat the same few summary
   * phrases — 80 units off a 25-phrase pool is ~3.2 copies each, identical
   * across seeds. So unitCi is an interval on replicates, not on decisions, and
   * every CI quoted r58-r65 was correspondingly overconfident. This is the
   * denominator that bounds what the round can actually distinguish.
   */
  phraseN: number;
  /** r59: the misjudged units themselves, so error has a cause not just a rate. */
  misses: { text: string; truth: boolean }[];
  ci: [number, number]; // Wilson 95% on exact-match — see docs/eval.md §7
  tokens: number; // total prompt+completion tokens, the cost axis
  detail: { seed: number; got: string; want: number; ok: number }[];
};

export async function run(
  round: string,
  strategy: "baseline" | "census",
  { units = 120, seeds = 5, budget = 12000 } = {},
): Promise<Result> {
  const t0 = Date.now();
  const detail: Result["detail"] = [];
  let calls = 0;
  let errors = 0;
  let errSum = 0;
  let tokens = 0;
  // r58: per-unit judgment tally, accumulated across every seed.
  let unitHits = 0;
  let unitN = 0;
  const misses: { text: string; truth: boolean }[] = [];

  for (let s = 0; s < seeds; s++) {
    if (Date.now() - t0 > CAP_MS) {
      console.error(`! 15-minute cap hit after ${s} seeds — run is INVALID`);
      break;
    }
    // r52: HARD=1 mixes in the near-miss pairs. Env rather than a positional
    // arg — every existing invocation in docs/eval.md stays valid unchanged.
    const task = makeTask(1000 + s, units, process.env.HARD === "1");
    const r = strategy === "baseline" ? await baseline(task) : await census(task, budget);
    calls += r.calls;
    tokens += r.tokens;
    if (r.error) errors++;
    const ok = r.error ? 0 : scoreTask(r.reply, task.answer);
    // err=1 on a failed call: an unanswered seed is maximally wrong, never free.
    errSum += r.error ? 1 : countError(r.reply, task.answer);
    // Compare each verdict against its own ground truth. A seed that overcounts
    // by 5 may have got 75/80 judgments right — countErr cannot see that, and
    // that invisible detail is most of the evidence in the run.
    if (r.verdicts) {
      for (let i = 0; i < r.verdicts.length; i++) {
        unitN++;
        if (r.verdicts[i] === task.truth[i]) unitHits++;
        // r59: name the unit that was misjudged. unitAcc says ~15 units per
        // round are wrong; without the text, that is a number with no cause
        // attached. Summary line only — the ticket body is regenerable from seed.
        else {
          const m = task.units[i].match(/The customer (.*)\./);
          misses.push({ text: m?.[1] ?? task.units[i].slice(0, 60), truth: task.truth[i] });
        }
      }
    }
    detail.push({ seed: 1000 + s, got: r.error ? `ERR ${r.error.slice(0, 60)}` : r.reply, want: task.answer, ok });
    console.log(`  seed ${1000 + s}: got ${detail.at(-1)!.got} want ${task.answer} -> ${ok}`);
  }

  const hits = detail.reduce((a, d) => a + d.ok, 0);
  const res: Result = {
    round,
    strategy,
    units,
    seeds: detail.length,
    score: detail.length ? hits / detail.length : 0,
    hits,
    ms: Date.now() - t0,
    calls,
    errors,
    meanCountError: detail.length ? errSum / detail.length : 1,
    ci: wilson(hits, detail.length),
    unitAcc: unitN ? unitHits / unitN : 0,
    unitN,
    unitCi: wilson(unitHits, unitN),
    phraseN: phrasePoolSize(process.env.HARD === "1", process.env.WIDE === "1"),
    misses,
    tokens,
    detail,
  };
  appendFileSync(LOG, JSON.stringify(res) + "\n");
  return res;
}

/**
 * r69: the instrument docs/eval.md §2 designated as THE hillclimb signal and
 * that r43-r68 never ran -- src/fwe.ts existed and was imported by nothing.
 * FWE is unanswerable from top-k (frequency counting requires reading every
 * token), needs no API judge, and self-generates, so there is no held-out set
 * to exhaust and no corpus for me to mislabel. Everything src/task.ts is not.
 * Scored with partial credit via fwe.score, so a round yields a gradient.
 */
export async function runFwe(
  round: string,
  strategy: "baseline" | "census",
  // seedBase defaults to 2000 so every round logged before this parameter existed
  // reproduces exactly. The r69 gate needs a base OUTSIDE the tuning sets
  // (1000-1019, 2000-2002) -- pass seedBase >= 3000 for a held-out round.
  { words = 128000, seeds = 5, seedBase = 2000 } = {},
) {
  const t0 = Date.now();
  const detail: { seed: number; got: string; want: string; ok: number }[] = [];
  let calls = 0, tokens = 0, errors = 0, sum = 0;

  for (let s = 0; s < seeds; s++) {
    if (Date.now() - t0 > CAP_MS) {
      console.error(`! 15-minute cap hit after ${s} seeds — run is INVALID`);
      break;
    }
    const seed = seedBase + s;
    const item = makeItem(seed, words);
    const r = strategy === "baseline" ? await fweBaseline(item) : await fweCensus(item);
    calls += r.calls;
    tokens += r.tokens;
    if (r.error) errors++;
    const ok = r.error ? 0 : score(r.reply.join(","), item.answer);
    sum += ok;
    detail.push({
      seed,
      got: r.error ? `ERR ${r.error.slice(0, 60)}` : r.reply.join(","),
      want: item.answer.join(","),
      ok,
    });
    console.log(`  seed ${seed}: got ${detail.at(-1)!.got} want ${item.answer.join(",")} -> ${ok.toFixed(2)}`);
  }

  const exact = detail.filter((d) => d.ok === 1).length;
  const res = {
    round,
    strategy: `fwe-${strategy}`,
    units: words,
    seeds: detail.length,
    score: detail.length ? sum / detail.length : 0, // partial-credit mean
    hits: exact,
    ms: Date.now() - t0,
    calls,
    errors,
    ci: wilson(exact, detail.length), // on EXACT match only; partial score has no Wilson
    tokens,
    detail,
  };
  appendFileSync(LOG, JSON.stringify(res) + "\n");
  return res;
}

if (process.argv[1]?.endsWith("eval.ts")) {
  const [, , round = "adhoc", strategy = "census", units = "120", seeds = "5", budget = "12000"] =
    process.argv;
  // FWE=1 switches instrument, not strategy: `FWE=1 ... <round> census <words> <seeds>`.
  if (process.env.FWE === "1") {
    // SEED_BASE=3000 runs the r69 held-out gate; unset reproduces prior rounds.
    const r = await runFwe(round, strategy as "baseline" | "census", {
      words: +units,
      seeds: +seeds,
      seedBase: +(process.env.SEED_BASE ?? 2000),
    });
    console.log(
      `\n${r.round} ${r.strategy} words=${r.units} -> score ${(r.score * 100).toFixed(1)}% ` +
        `(exact ${r.hits}/${r.seeds}) [95% CI ${(r.ci[0] * 100).toFixed(0)}-${(r.ci[1] * 100).toFixed(0)}%] ` +
        `${(r.ms / 1000).toFixed(1)}s ${r.calls} calls ${(r.tokens / 1000).toFixed(1)}k tok ${r.errors} err`,
    );
    process.exit(0);
  }
  const r = await run(round, strategy as "baseline" | "census", {
    units: +units,
    seeds: +seeds,
    budget: +budget,
  });
  console.log(
    `\n${r.round} ${r.strategy} units=${r.units} -> score ${(r.score * 100).toFixed(0)}% ` +
      `(${r.hits}/${r.seeds}) [95% CI ${(r.ci[0] * 100).toFixed(0)}-${(r.ci[1] * 100).toFixed(0)}%] ` +
      `countErr ${(r.meanCountError * 100).toFixed(1)}% ` +
      `unitAcc ${(r.unitAcc * 100).toFixed(2)}% [${(r.unitCi[0] * 100).toFixed(2)}-${(r.unitCi[1] * 100).toFixed(2)}%] n=${r.unitN} over ${r.phraseN} phrases ` +
      `${(r.ms / 1000).toFixed(1)}s ${r.calls} calls ${(r.tokens / 1000).toFixed(1)}k tok ${r.errors} err`,
  );
}
