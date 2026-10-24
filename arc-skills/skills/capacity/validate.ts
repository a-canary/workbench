#!/usr/bin/env bun
// validate.ts — hermetic replay harness for arcsim. Zero network calls.
//   bun validate.ts --round 1..5 --seed 42 --out /results/capacity-r1.json
// Rounds: 1 nominal · 2 silent-plan-downgrade · 3 full-day outage ·
//         4 weekly-cap + 4x burst · 5 cold-start empty DB.
// Exercises the real bun:sqlite path ($CAPACITY_DB, default /tmp) and the
// CLI fail-open red line every round.

import { Database } from "bun:sqlite";
import { estimate, type Outcome } from "./estimator.ts";
import { arbitrate } from "./arbitrate.ts";

const argv = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const ROUND = Number(argv("round", "1"));
const SEED = Number(argv("seed", "42"));
const OUT = argv("out", "/tmp/capacity-validate.json");
const DB_PATH = process.env.CAPACITY_DB ?? "/tmp/capacity-validate.db";

const lcg = (s: number) => () => (s = (s * 48271) % 2147483647) / 2147483647;
const T0 = 1_750_000_000;
const H = 3600;

type Truth = { name: string; W: number; C: number; weekly: number };
type Sim = { rows: Outcome[]; blockedHours: Set<number>; hours: number };

// Same traffic model as the seed-42 reference sim (estimator-sim.ts).
function gen(truth: Truth, seed: number, days: number, opts: {
  downgradeAtDay?: number; downgradeC?: number; outageDay?: number; burstX?: number;
} = {}): Sim {
  const rnd = lcg(seed);
  let C = truth.C, win = C, wk = truth.weekly;
  const rows: Outcome[] = [];
  const blockedHours = new Set<number>();
  for (let h = 0; h < days * 24; h++) {
    if (opts.downgradeAtDay !== undefined && h === opts.downgradeAtDay * 24) C = opts.downgradeC!;
    if (h % truth.W === 0) win = C;
    if (h % (7 * 24) === 0) wk = truth.weekly;
    const outage = opts.outageDay !== undefined && h >= opts.outageDay * 24 && h < (opts.outageDay + 1) * 24;
    const burst = (h % 24 >= 8 && h % 24 < 22 ? 1.4 : 0.2) * (0.5 + rnd()) * (opts.burstX ?? 1);
    let demand = Math.floor(900_000 * burst);
    let i = 0;
    while (demand > 0) {
      const req = Math.min(150_000, demand);
      demand -= req;
      const ts = T0 + h * H + i++ * 60;
      if (!outage && win >= req && wk >= req) {
        win -= req; wk -= req;
        rows.push({ ts, provider: truth.name, tokens: req, status: "ok" });
      } else {
        rows.push({ ts, provider: truth.name, tokens: 0, status: "429" });
        blockedHours.add(h);
        break; // back off rest of hour
      }
    }
  }
  return { rows, blockedHours, hours: days * 24 };
}

// Hour-by-hour lane behavior vs ground truth.
function laneMetrics(sim: Sim, provider: string) {
  let criticalParks = 0, researchParksAtBlocked = 0, blockedEvals = 0;
  let ri = 0;
  const seen: Outcome[] = [];
  for (let h = 0; h < sim.hours; h++) {
    while (ri < sim.rows.length && sim.rows[ri].ts < T0 + (h + 1) * H) seen.push(sim.rows[ri++]);
    if (seen.length === 0) continue;
    const est = estimate(seen, provider);
    if (arbitrate(est, "critical").action === "park") criticalParks++;
    if (sim.blockedHours.has(h)) {
      blockedEvals++;
      if (arbitrate(est, "research").action === "park") researchParksAtBlocked++;
    }
  }
  return {
    criticalSloMisses: criticalParks,
    researchParkCorrectness: blockedEvals ? researchParksAtBlocked / blockedEvals : 1,
    blockedEvals,
  };
}

// Prove the sqlite path: insert → select → identical estimate.
function dbRoundtrip(rows: Outcome[], provider: string): boolean {
  try { require("node:fs").rmSync(DB_PATH); } catch {}
  const d = new Database(DB_PATH, { create: true });
  d.exec("PRAGMA journal_mode=WAL");
  d.exec("CREATE TABLE IF NOT EXISTS outcomes (ts INTEGER, provider TEXT, tokens INTEGER, status TEXT, meta TEXT)");
  const ins = d.query("INSERT INTO outcomes (ts, provider, tokens, status, meta) VALUES (?,?,?,?,NULL)");
  d.transaction(() => { for (const r of rows) ins.run(r.ts, r.provider, r.tokens, r.status); })();
  const back = d.query("SELECT ts, provider, tokens, status FROM outcomes").all() as Outcome[];
  return JSON.stringify(estimate(back, provider)) === JSON.stringify(estimate(rows, provider));
}

// The red line, exercised every round: broken DB → {"action":"run","fail_open":true}, exit 0.
function failOpenCheck(): { pass: boolean; verdict: unknown } {
  const cli = new URL("./capacity.ts", import.meta.url).pathname;
  const p = Bun.spawnSync(["bun", cli, "route", "--provider", "x", "--lane", "critical"], {
    env: { ...process.env, CAPACITY_DB: "/dev/null/nope/x.db" },
  });
  try {
    const v = JSON.parse(p.stdout.toString().trim());
    return { pass: p.exitCode === 0 && v.action === "run" && v.fail_open === true, verdict: v };
  } catch (e) {
    return { pass: false, verdict: String(e) };
  }
}

function vastStopCheck(): boolean {
  const blockedEst = { ...estimate([], "p"), blocked: true, known: true };
  const at29 = arbitrate(blockedEst, "research", { parkedMinutes: 29 });
  const at30 = arbitrate(blockedEst, "research", { parkedMinutes: 30 });
  return at29.action === "park" && at29.vast_stop === false && at30.vast_stop === true;
}

type Gate = { name: string; value: number | boolean | string; threshold: string; pass: boolean };
const gates: Gate[] = [];
const gate = (name: string, value: number | boolean | string, threshold: string, pass: boolean) =>
  gates.push({ name, value, threshold, pass });

const TRUTHS: Truth[] = [
  { name: "claude-max-like", W: 5, C: 2_500_000, weekly: 80_000_000 },
  { name: "minimax-like", W: 5, C: 5_000_000, weekly: 100_000_000 },
];
let scenario = "";
const metrics: Record<string, unknown> = {};

if (ROUND === 1) {
  scenario = "nominal";
  for (const t of TRUTHS) {
    const sim = gen(t, SEED, 14);
    const est = estimate(sim.rows, t.name);
    const recovery = (est.capLB ?? 0) / t.C;
    const windowErr = Math.abs((est.windowHours ?? 999) - t.W);
    const lanes = laneMetrics(sim, t.name);
    metrics[t.name] = { est, recovery, windowErr, lanes };
    gate(`${t.name}/cap-recovery`, Number(recovery.toFixed(3)), ">=0.85", recovery >= 0.85);
    gate(`${t.name}/window-error-h`, windowErr, "<=1", windowErr <= 1);
    gate(`${t.name}/critical-slo-misses`, lanes.criticalSloMisses, "=0", lanes.criticalSloMisses === 0);
    gate(`${t.name}/research-park-correctness`, Number(lanes.researchParkCorrectness.toFixed(3)), ">=0.95", lanes.researchParkCorrectness >= 0.95);
    gate(`${t.name}/db-roundtrip`, dbRoundtrip(sim.rows, t.name), "=true", dbRoundtrip(sim.rows, t.name));
  }
} else if (ROUND === 2) {
  scenario = "silent-plan-downgrade";
  const t = TRUTHS[1]; // minimax-like 5M → 2.5M at day 7
  const newC = 2_500_000;
  const sim = gen(t, SEED, 14, { downgradeAtDay: 7, downgradeC: newC });
  const est = estimate(sim.rows, t.name);
  const recovery = (est.capLB ?? 0) / newC;
  metrics[t.name] = { est, recoveryVsNewCap: recovery };
  gate("downgrade/cap-recovery-vs-new", Number(recovery.toFixed(3)), "0.85..1.15", recovery >= 0.85 && recovery <= 1.15);
  gate("downgrade/window-error-h", Math.abs((est.windowHours ?? 999) - t.W), "<=1", Math.abs((est.windowHours ?? 999) - t.W) <= 1);
} else if (ROUND === 3) {
  scenario = "full-day-outage";
  const t = TRUTHS[0];
  const sim = gen(t, SEED, 14, { outageDay: 7 });
  const est = estimate(sim.rows, t.name);
  const lanes = laneMetrics(sim, t.name);
  const windowErr = Math.abs((est.windowHours ?? 999) - t.W);
  metrics[t.name] = { est, windowErr, lanes };
  gate("outage/critical-slo-misses", lanes.criticalSloMisses, "=0", lanes.criticalSloMisses === 0);
  gate("outage/research-park-correctness", Number(lanes.researchParkCorrectness.toFixed(3)), ">=0.95", lanes.researchParkCorrectness >= 0.95);
  gate("outage/window-error-h", windowErr, "<=1", windowErr <= 1);
  gate("outage/cap-recovery", Number(((est.capLB ?? 0) / t.C).toFixed(3)), ">=0.85", (est.capLB ?? 0) / t.C >= 0.85);
} else if (ROUND === 4) {
  scenario = "weekly-cap-4x-burst";
  const t = { ...TRUTHS[1], weekly: 40_000_000 };
  const sim = gen(t, SEED, 14, { burstX: 4 });
  const est = estimate(sim.rows, t.name);
  const windowErr = Math.abs((est.windowHours ?? 999) - t.W);
  metrics[t.name] = { est, windowErr };
  gate("weekly/weekly-class-detected", est.weeklyCapLB !== null, "=true", est.weeklyCapLB !== null);
  gate("weekly/window-error-h", windowErr, "<=1", windowErr <= 1);
  gate("weekly/cap-recovery", Number(((est.capLB ?? 0) / t.C).toFixed(3)), ">=0.85", (est.capLB ?? 0) / t.C >= 0.85);
} else if (ROUND === 5) {
  scenario = "cold-start-empty-db";
  const t = TRUTHS[0];
  const sim = gen(t, SEED, 2, { burstX: 0.1 }); // 48h light traffic, zero 429s expected
  const est = estimate(sim.rows, t.name);
  let nonRun = 0, evals = 0;
  for (const lane of ["critical", "research", "standard"] as const) {
    evals++;
    if (arbitrate(est, lane).action !== "run") nonRun++;
    evals++;
    if (arbitrate(estimate([], t.name), lane).action !== "run") nonRun++; // truly empty DB
  }
  metrics[t.name] = { est, nonRun, evals, blocks: est.blocks };
  gate("cold/never-blocked-stays-green", nonRun, "=0", nonRun === 0);
  gate("cold/unknown-not-known", est.blocks === 0 && !est.known, "=true", est.blocks === 0 && !est.known);
} else {
  throw new Error(`unknown round ${ROUND}`);
}

// Universal gates, every round.
const fo = failOpenCheck();
gate("fail-open", fo.pass, "=true (red line)", fo.pass);
gate("vast-stop-30min", vastStopCheck(), "=true", vastStopCheck());

const pass = gates.every((g) => g.pass);
const result = { round: ROUND, scenario, seed: SEED, pass, gates, metrics };
await Bun.write(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ round: ROUND, scenario, pass, gates: gates.map((g) => `${g.pass ? "PASS" : "FAIL"} ${g.name}=${g.value} (${g.threshold})`) }, null, 1));
process.exit(pass ? 0 : 1);
