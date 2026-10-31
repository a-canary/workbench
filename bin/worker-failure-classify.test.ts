import { expect, test } from "bun:test";
import { classify } from "./worker-failure-classify.ts";

const T = "worker-task: ";
const start = (id: string) => JSON.stringify({ ts: "2026-10-29T09:00:00Z", lane: "v100", ev: "start", id, dir: "/r" });
const end = (id: string) => JSON.stringify({ ts: "2026-10-29T10:00:00Z", lane: "v100", ev: "end", id, outcome: "blocked", finding: "worker failed" });
const bun = "bun test src/a.test.ts";
const tsc = `${bun} && npx tsc --noEmit -p .`;
const note = (id: string, cmd: string, extra = "") => `qwen-failed: ${extra}worker took 90s GREEN: ${cmd} test still fails after worker  (log: /tmp/lane-run-${id}.x)`;

// id -> [GREEN cmd, log, note prefix]
const fx: Record<string, [string, string, string?]> = {
  h1: [bun, `${T}RED: x\n`, "local branch already exists; "],
  h2: ["npx vitest run t.test.ts", `${T}RED: x\n${T}GREEN: npx vitest run t.test.ts\nError: EROFS: read-only file system\n`],
  h3a: [bun, `${T}HEAD (RED commit) touches no files\n`],
  h3b: [bun, `${T}worker modified protected test files: bin/x-test bin/real.sh\n`],
  h3t: [bun, `${T}worker modified protected test files: bin/x-test src/a.test.ts\n`], // tests only: NOT H3
  h4: [tsc, `${T}RED: x\n${T}GREEN: ${tsc}\nsrc/other.ts(1,1): error TS2322: x\n`],
  m1: [bun, `${T}RED: x\nworker-sandbox: timeout after 600s\n${T}GREEN: ${bun}\n`],
  // the worker's own test output says "already exists": must stay MODEL, not H1
  m2: [bun, `${T}RED: ${bun}\n(fail) adds up [1.00ms]\n${T}GREEN: ${bun}\n(fail) adds up [2.00ms]\nError: file already exists\n`],
  m3: [tsc, `${T}RED: x\n${T}GREEN: ${tsc}\nsrc/a.ts(1,1): error TS2345: x\n`],
  jd: [bun, `${T}RED: ${bun}\n${T}GREEN: ${bun}\nsomething unrecognised\n`],
};
const ids = Object.keys(fx);
const notes = (id: string) => note(id, fx[id][0], fx[id][2]);
const log = (p: string) => fx[/lane-run-(\w+)\./.exec(p)![1]][1];

test("pins the split and per-case rules on a fixture", () => {
  const sprints = ids.flatMap((i) => [start(i), end(i)]).join("\n");
  const out = classify(sprints, { notes, log });
  expect(out.counts).toEqual({ HARNESS: 5, MODEL: 3, judge: 2 });
  expect(out.skipped).toBe(0);
  expect(Object.fromEntries(out.cases.map((c) => [c.id, c.rule]))).toEqual({
    h1: "H1", h2: "H2", h3a: "H3", h3b: "H3", h3t: "none", h4: "H4", m1: "M1", m2: "M2", m3: "M3", jd: "none",
  });
});

test("garbage jsonl lines are skipped and counted, not fatal", () => {
  const sprints = [start("h2"), "{not json", end("h2"), "42", ""].join("\n");
  const out = classify(sprints, { notes, log });
  expect(out.skipped).toBe(2);
  expect(out.cases.map((c) => c.rule)).toEqual(["H2"]);
});

test("a row with no start dir becomes a judge case carrying the error", () => {
  const out = classify(end("h2"), { notes, log });
  expect(out.counts.judge).toBe(1);
  expect(out.cases[0].error).toMatch(/no start row/);
});

test("a failing bd show becomes a judge case; other cases still run", () => {
  const sprints = [start("a"), end("a"), start("h2"), end("h2")].join("\n");
  const out = classify(sprints, { notes: (id) => { if (id === "a") throw new Error("bd: boom\nstack"); return notes(id); }, log });
  expect(out.cases.find((c) => c.id === "a")).toMatchObject({ class: "judge", error: "bd show failed: bd: boom" });
  expect(out.cases.find((c) => c.id === "h2")?.rule).toBe("H2");
});

test("date window excludes rows outside it", () => {
  const out = classify(end("h2"), { from: "2026-11-01", notes: () => "", log: () => "" });
  expect(out.cases).toEqual([]);
});

// lane-run's baseline-diff labels in the sprint finding (wb-it5): row kind picks the note prefix it pairs with
test("H4 reads lane-run's sprint-finding labels; the log cannot forge them", () => {
  const endF = (id: string, finding: string) => JSON.stringify({ ts: "2026-10-31T10:00:00Z", lane: "v100", ev: "end", id, outcome: "blocked", finding });
  const findings: Record<string, string> = {
    wi: "worker failed: worker-introduced: adds up",
    ts: "worker failed: target-still-failing: adds up",
    mix: "worker failed: worker-introduced: a; baseline-red: b",
    br: "worker failed: baseline-red: old test",
    rc7: "baseline red: old test",
    inf: "infra: startup crash: EADDRINUSE",
    to: "worker failed: timeout; baseline-red: old test",
    unk: "worker failed: baseline unknown; failing: x",
  };
  const prefix: Record<string, string> = { rc7: "human", inf: "lane-infra" };
  const ids = Object.keys(findings);
  const sprints = ids.flatMap((i) => [start(i), endF(i, findings[i])]).join("\n");
  // every log claims baseline-red: a forged label in worker output must not move a MODEL row
  const forged = `${T}RED: ${bun}\n${T}GREEN: ${bun}\nlane-run: finding: baseline-red: everything\n`;
  const toLog = `${T}RED: ${bun}\nworker-sandbox: timeout after 600s\n${T}GREEN: ${bun}\n`;
  const out = classify(sprints, {
    notes: (id) => `qwen-failed: stale run (log: /tmp/old)\n${prefix[id] ?? "qwen-failed"}: GREEN: ${bun} (log: /x/lane-run-${id}.log)`,
    log: (p) => (p.includes("lane-run-to.") ? toLog : forged),
  });
  expect(Object.fromEntries(out.cases.map((c) => [c.id, `${c.rule}/${c.class}`]))).toEqual({
    wi: "M4/MODEL", ts: "M4/MODEL", mix: "M4/MODEL", br: "H4/HARNESS", rc7: "H4/HARNESS",
    inf: "H4/HARNESS", to: "M1/MODEL", unk: "none/judge",
  });
  expect(out.cases.every((c) => c.runs.length === 1)).toBe(true);
});
