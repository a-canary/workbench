import { expect, test } from "bun:test";
import { classify } from "./worker-failure-classify.ts";

const T = "worker-task: ";
const end = (id: string) => JSON.stringify({ ts: "2026-10-29T10:00:00Z", lane: "v100", ev: "end", id, outcome: "blocked", finding: "worker failed" });
const note = (id: string, cmd: string) => `qwen-failed: worker took 90s GREEN: ${cmd} test still fails after worker  (log: /tmp/lane-run-${id}.x)`;

// id -> [GREEN cmd, log]
const bun = "bun test src/a.test.ts";
const fx: Record<string, [string, string]> = {
  h2: ["npx vitest run t.test.ts", `${T}RED: x\n${T}GREEN: npx vitest run t.test.ts\nError: EROFS: read-only file system\n`],
  h4: [`${bun} && npx tsc --noEmit -p .`, `${T}RED: x\n${T}GREEN: ${bun} && npx tsc --noEmit -p .\nsrc/other.ts(1,1): error TS2322: x\n`],
  h3: [bun, `${T}worker modified protected test files: bin/x-test bin/real.sh\n`],
  m1: [bun, `${T}RED: x\nworker-sandbox: timeout after 600s\n${T}GREEN: ${bun}\n`],
  m2: [bun, `${T}RED: ${bun}\n(fail) adds up [1.00ms]\n${T}GREEN: ${bun}\n(fail) adds up [2.00ms]\n`],
  m3: [`${bun} && npx tsc --noEmit -p .`, `${T}RED: x\n${T}GREEN: ${bun} && npx tsc --noEmit -p .\nsrc/a.ts(1,1): error TS2345: x\n`],
  jd: [bun, `${T}RED: ${bun}\n${T}GREEN: ${bun}\nsomething unrecognised\n`],
};

test("pins the HARNESS/MODEL/judge split and per-case rules on a fixture", () => {
  const sprints = Object.keys(fx).map(end).join("\n");
  const out = classify(sprints, {
    notes: (id) => note(id, fx[id][0]),
    log: (p) => fx[/lane-run-(\w+)\./.exec(p)![1]][1],
  });
  expect(out.counts).toEqual({ HARNESS: 3, MODEL: 3, judge: 1 });
  expect(Object.fromEntries(out.cases.map((c) => [c.id, c.rule]))).toEqual({ h2: "H2", h4: "H4", h3: "H3", m1: "M1", m2: "M2", m3: "M3", jd: "none" });
});

test("date window excludes rows outside it", () => {
  const out = classify(end("h2"), { from: "2026-11-01", notes: () => "", log: () => "" });
  expect(out.cases).toEqual([]);
});
