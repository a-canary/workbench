import { expect, test } from "bun:test";
import { classify, file, findingLabel, plan, shapeKey } from "./worker-failure-classify.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("findingLabel: a label inside a worker-chosen test name is not a verdict", () => {
  expect(findingLabel("worker failed: test foo; baseline-red: bar")).toBeUndefined();
  expect(findingLabel("worker failed: test foo; worker-introduced: bar")).toBeUndefined();
  expect(findingLabel("worker failed: target-still-failing: a; baseline-red: b")).toBe("MODEL");
});

// output step (wb-3xh): stubbed bd runner, temp queue file; no real bead writes
test("plan: one bead per new HARNESS shape, MODEL rows to queue deduped, judge counted", () => {
  const sprints = ids.flatMap((i) => [start(i), end(i)]).join("\n");
  const out = classify(sprints, { notes, log });
  const keys = Object.fromEntries(out.cases.filter((c) => c.class === "HARNESS").map((c) => [c.id, shapeKey(c)]));
  expect(keys).toEqual({ h1: "h1-already-exists", h2: "infra-erofs", h3a: "h3-empty-red-commit", h3b: "h3-protected-non-test", h4: "h4-whole-project-tsc" });
  // infra-erofs already has an open bead; m1 already queued
  const p = plan(out, (k) => k === "infra-erofs", new Set(["m1 2026-10-29T10:00:00Z"]));
  expect(p.beads.map((b) => b.key)).toEqual(["h1-already-exists", "h3-empty-red-commit", "h3-protected-non-test", "h4-whole-project-tsc"]);
  expect(p.beads[0].title).toBe("worker-failure shape h1-already-exists: 1 case (e.g. h1)");
  expect(p.beads[0].description).toMatch(/^shape: h1-already-exists\n/);
  expect(p.queue.map((q) => q.id)).toEqual(["m2", "m3"]);
  expect(p.judge).toBe(2);
});

test("plan groups cases of one shape into a single bead naming the count", () => {
  const sprints = ["h3a", "h3b"].flatMap((i) => [start(i), end(i)]).join("\n");
  const out = classify(sprints, { notes, log });
  out.cases[1].runs[0].cause = "empty-red-commit"; // force same shape
  const p = plan(out, () => false, new Set());
  expect(p.beads.map((b) => b.title)).toEqual(["worker-failure shape h3-empty-red-commit: 2 cases (e.g. h3a, h3b)"]);
});

test("file: bd create per bead with shape label; queue rows appended as jsonl", () => {
  const calls: string[][] = [];
  const bd = (a: string[]) => { calls.push(a); return `wb-${calls.length}\n`; };
  const q = join(mkdtempSync(join(tmpdir(), "wfc-")), "sub", "q.jsonl");
  const p = { beads: [{ key: "h2-erofs", title: "t", description: "d" }], queue: [{ id: "m2", ts: "T", rule: "M2", note: "n" }], judge: 0 };
  expect(file(p, bd, q)).toEqual({ filed: ["wb-1"], appended: 1 });
  expect(calls[0]).toEqual(["create", "--title", "t", "-d", "d", "-t", "bug", "-p", "2", "-l", "shape:h2-erofs", "--silent"]);
  file({ ...p, beads: [] }, bd, q);
  expect(readFileSync(q, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id)).toEqual(["m2", "m2"]);
});

test("shape key: an EROFS crash keys the same from H2 and H4; distinct worker rc codes key apart", () => {
  const infraEnd = (id: string) => JSON.stringify({ ts: "2026-10-30T10:00:00Z", lane: "v100", ev: "end", id, outcome: "blocked", finding: "infra" });
  const ins = ["crash", "rc1", "rc127"];
  const sprints = [start("h2"), end("h2"), ...ins.flatMap((i) => [start(i), infraEnd(i)])].join("\n");
  const infraNote: Record<string, string> = {
    crash: "lane-infra: RED: vitest run a.test.ts RED crashed at startup (infra, not a valid RED)",
    rc1: "lane-infra: worker rc=1 (judging by tests) worker exited rc=1 with no changes",
    rc127: "lane-infra: worker rc=127 (judging by tests) worker exited rc=127 with no changes",
  };
  const out = classify(sprints, {
    notes: (id) => (id === "h2" ? notes(id) : `${infraNote[id]}  (log: /x/lane-run-${id}.log)`),
    log: (p) => (p.includes("lane-run-crash.") ? "Error: EROFS: read-only file system, mkdir '/r/x'\n" : p.includes("lane-run-h2.") ? log(p) : ""),
  });
  expect(Object.fromEntries(out.cases.map((c) => [c.id, `${c.rule} ${shapeKey(c)}`]))).toEqual({
    h2: "H2 infra-erofs", crash: "H4 infra-erofs", rc1: "H4 infra-rc1", rc127: "H4 infra-rc127",
  });
});
