import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { next, readDbs, type Ctx } from "./cli.ts";

const bead = (id: string, priority: number, extra: object = {}) =>
  ({ id, priority, created_at: "2026-10-01", updated_at: "2026-10-01", title: `t-${id}`, labels: [], issue_type: "task", status: "open", ...extra });

function ctx(db: Record<string, { ready?: object[]; claimed?: object[]; v100Ready?: number; v100Running?: number }>, over: Partial<Ctx> = {}) {
  const d = mkdtempSync(join(tmpdir(), "queue-cli-"));
  const out: string[] = [];
  const warn: string[] = [];
  const c: Ctx = {
    dbs: Object.keys(db),
    steer: join(d, "steer.json"),
    exec: (cmd) => {
      if (cmd[0] === "curl") return "";
      const x = db[cmd[2]!];
      if (!x) return "not json";
      const v100 = cmd.includes("lane:v100") && cmd.includes("-l");
      if (cmd[3] === "ready") return JSON.stringify(v100 ? Array(x.v100Ready ?? 0).fill({}) : x.ready ?? []);
      return JSON.stringify(v100 ? Array(x.v100Running ?? 0).fill({}) : x.claimed ?? []);
    },
    print: (s) => out.push(s),
    warn: (s) => warn.push(s),
    now: Date.parse("2026-10-29T00:00:00Z"),
    ...over,
  };
  return { c, out, warn, d };
}

test("merges every configured db, ranks, prints the top N", () => {
  const { c, out } = ctx({ "/r/a": { ready: [bead("a-2", 2)] }, "/r/b": { ready: [bead("b-1", 1), bead("b-3", 3)] } });
  expect(next(c, 2)).toBe(0);
  expect(out).toEqual(["/r/b\tb-1\tP1\tt-b-1\n/r/a\ta-2\tP2\tt-a-2"]);
});

test("stale claims come from the in-progress list; operator steering pins and skips", () => {
  const { c, out } = ctx({ "/r/a": { ready: [bead("a-1", 1), bead("a-3", 3)], claimed: [bead("a-9", 2, { status: "in_progress" })] } });
  writeFileSync(c.steer, JSON.stringify({ pin: ["a-3"], skip: ["a-1"] }));
  next(c, 5);
  expect(out[0]).toBe("/r/a\ta-3\tP3\t[pinned] t-a-3\n/r/a\ta-9\tP2\t[stale-claim] t-a-9");
});

test("an unreadable db warns and the rest still rank", () => {
  const { c, out, warn } = ctx({ "/r/a": { ready: [bead("a-1", 1)] } }, { dbs: ["/r/gone", "/r/a"] });
  expect(next(c, 1)).toBe(0);
  expect(out).toEqual(["/r/a\ta-1\tP1\tt-a-1"]);
  expect(warn.join("\n")).toContain("/r/gone");
  c.dbs = ["/r/gone"]; // every db unreadable is an error, not an empty queue
  expect(next(c, 1)).toBe(1);
});

test("v100-starved row when the lane is up, nothing runs, and its queue is idle", () => {
  const lanes = (busy: object) => (cmd: string[]) =>
    cmd[0] === "curl" ? (cmd.at(-1)!.endsWith("/v1/models") ? "200" : JSON.stringify(busy)) : "[]";
  const { c, out } = ctx({ "/r/a": { ready: [bead("a-1", 1)], v100Ready: 4 } }, { laneUrl: "http://lane" });
  const base = c.exec;
  c.exec = (cmd) => (cmd[0] === "curl" ? lanes({ waiting: [], slots: [{ lane: null }] })(cmd) : base(cmd));
  next(c, 2);
  expect(out[0]).toBe("-\tv100-starved\tP0\t[v100-starved] V100 idle (4 lane:v100 ready, 0 running): decompose one into lane-run RED-test beads, then run lane-run\n/r/a\ta-1\tP1\tt-a-1");

  out.length = 0; // queue busy (another agent saturates it) → not starved
  c.exec = (cmd) => (cmd[0] === "curl" ? lanes({ waiting: [1], slots: [] })(cmd) : base(cmd));
  next(c, 2);
  expect(out[0]).toBe("/r/a\ta-1\tP1\tt-a-1");

  out.length = 0; // a lane:v100 bead already running → not starved
  const running = ctx({ "/r/a": { ready: [bead("a-1", 1)], v100Running: 1 } }, { laneUrl: "http://lane" });
  const rb = running.c.exec;
  running.c.exec = (cmd) => (cmd[0] === "curl" ? lanes({ waiting: [], slots: [] })(cmd) : rb(cmd));
  next(running.c, 2);
  expect(running.out[0]).toBe("/r/a\ta-1\tP1\tt-a-1");

  out.length = 0; // garbled /__lanes or an unreadable db could hide a running bead → fail closed
  c.exec = (cmd) => (cmd[0] === "curl" ? (cmd.at(-1)!.endsWith("/v1/models") ? "200" : "<html>") : base(cmd));
  next(c, 2);
  expect(out[0]).toBe("/r/a\ta-1\tP1\tt-a-1");
  out.length = 0;
  c.exec = (cmd) => (cmd[0] === "curl" ? lanes({ waiting: [], slots: [] })(cmd) : base(cmd));
  c.dbs = ["/r/a", "/r/gone"];
  next(c, 2);
  expect(out[0]).toBe("/r/a\ta-1\tP1\tt-a-1");
  c.dbs = ["/r/a"];

  out.length = 0; // lane down (502) → "down", not starved
  c.exec = (cmd) => (cmd[0] === "curl" ? "502" : base(cmd));
  next(c, 2);
  expect(out[0]).toBe("/r/a\ta-1\tP1\tt-a-1");
});

test("readDbs: one dir per line, blanks and # comments ignored", () => {
  const { d } = ctx({});
  const f = join(d, "dbs");
  writeFileSync(f, "/r/a\n\n# retired\n  /r/b  \n");
  expect(readDbs(f)).toEqual(["/r/a", "/r/b"]);
});
