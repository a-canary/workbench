import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { end, start, type Ctx } from "./cli.ts";

const BEAD = JSON.stringify([{ id: "wb-1", title: "port sprint steering file", priority: 2 }]);

function ctx(over: Partial<Ctx> = {}) {
  const d = mkdtempSync(join(tmpdir(), "sprint-cli-"));
  const out: string[] = [];
  const calls: string[][] = [];
  const c: Ctx = {
    lane: "claude",
    log: join(d, "sprints.jsonl"),
    steer: join(d, "steer.json"),
    dirs: ["/x/none", "/x/repo/"],
    exec: (cmd) => {
      calls.push(cmd);
      if (cmd[3] === "show") return cmd[2]?.startsWith("/x/repo") ? BEAD : "";
      if (cmd[3] === "memories") return cmd[4] === "sprint" ? "  mem-a\n    remember A\n" : "";
      if (cmd[0] === "ke") return "- [46.8%] Note\n  → ke/x.md\n";
      return "";
    },
    claim: () => true,
    hasKe: true,
    print: (s) => out.push(s),
    now: () => new Date("2026-10-29T00:00:00Z"),
    ...over,
  };
  const events = () => readFileSync(c.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { c, out, calls, events };
}

test("start: logs prep, consumes steering notes and the pin", () => {
  const t = ctx();
  writeFileSync(t.c.steer, JSON.stringify({ pin: ["wb-1", "wb-2"], notes: [{ ts: "t", text: "do x first" }] }));
  expect(start(t.c, "/x/repo", "wb-1")).toBe(0);
  const [e] = t.events();
  expect(e).toMatchObject({ ev: "start", lane: "claude", project: "repo", id: "wb-1", priority: 2, steer: [{ text: "do x first" }] });
  expect(e.mem).toEqual([{ key: "mem-a", text: "remember A" }]);
  expect(e.ke).toEqual([{ score: 46.8, title: "Note", path: "ke/x.md" }]);
  expect(JSON.parse(readFileSync(t.c.steer, "utf8"))).toMatchObject({ pin: ["wb-2"], notes: [] });
  expect(t.out.join("\n")).toContain("STEERING from operator");
});

test("start: ke is skipped when not on PATH; refused claim is reported", () => {
  const t = ctx({ hasKe: false, claim: () => false });
  expect(start(t.c, "/x/repo", "wb-1")).toBe(0);
  expect(t.calls.some((c) => c[0] === "ke")).toBe(false);
  expect(t.events()[0].ke).toEqual([]);
  expect(t.out[0]).toContain("claim refused");
});

test("start: unknown bead exits 2 and logs nothing", () => {
  const t = ctx();
  expect(start(t.c, "/x/none", "wb-1")).toBe(2);
  expect(() => t.events()).toThrow();
});

test("end: after a start, logs metrics + mission without a bead lookup", () => {
  const t = ctx();
  start(t.c, "/x/repo", "wb-1");
  const before = t.calls.length;
  expect(end(t.c, ["wb-1", "done", "shipped", "tests=12", "junk", "mission=hygiene: less"])).toBe(0);
  expect(t.calls.length).toBe(before);
  expect(t.events()[1]).toMatchObject({ ev: "end", id: "wb-1", outcome: "done", finding: "shipped", metrics: { tests: 12 }, mission: "hygiene: less" });
});

test("end: without a start, carries the bead identity from the first dir that has it", () => {
  const t = ctx();
  expect(end(t.c, ["wb-1", "blocked", "waiting"])).toBe(0);
  expect(t.events()[0]).toMatchObject({ ev: "end", dir: "/x/repo/", project: "repo", title: "port sprint steering file", nostart: true });
});

test("end: bad outcome exits 2", () => {
  const t = ctx();
  expect(end(t.c, ["wb-1", "finished", "x"])).toBe(2);
  expect(t.out[0]).toBe("outcome: done|checkpoint|blocked");
});
