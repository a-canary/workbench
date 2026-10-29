// Driver queue: rank ready + stale-claimed beads across bead DBs (port of driver-next.sh's jq/awk/sort).
import { test, expect } from "bun:test";
import { rank, format, type Bead } from "./rank.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const b = (id: string, priority: number, created_at: string, extra: Partial<Bead> = {}): Bead => ({
  dir: "/r", id, priority, created_at, updated_at: created_at, title: `t-${id}`, labels: [], issue_type: "task", status: "open", ...extra,
});
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const none = { pin: [], skip: [] };

test("orders by priority, then oldest created", () => {
  const rows = rank([b("c", 2, "2026-10-03"), b("a", 1, "2026-10-05"), b("b", 2, "2026-10-01")], [], none, NOW);
  expect(ids(rows)).toEqual(["a", "b", "c"]);
});

test("drops operator-gated, other-lane and epic beads", () => {
  const rows = rank([
    b("h", 1, "2026-10-01", { labels: ["human"] }),
    b("v", 1, "2026-10-01", { labels: ["lane:v100"] }),
    b("f", 1, "2026-10-01", { labels: ["lane:free"] }),
    b("e", 1, "2026-10-01", { issue_type: "epic" }),
    b("ok", 3, "2026-10-01", { labels: ["infra"] }),
  ], [], none, NOW);
  expect(ids(rows)).toEqual(["ok"]);
});

test("tags decided beads", () => {
  const [r] = rank([b("d", 2, "2026-10-01", { labels: ["decided", "design"] })], [], none, NOW);
  expect(r!.title).toBe("[decided] t-d");
});

test("in-progress beads count only when untouched 48h+ and not human or another lane's", () => {
  const rows = rank([], [
    b("old", 2, "2026-10-01", { status: "in_progress", updated_at: "2026-10-26T11:00:00Z" }),
    b("fresh", 2, "2026-10-01", { status: "in_progress", updated_at: "2026-10-26T13:00:00Z" }),
    b("oldh", 2, "2026-10-01", { status: "in_progress", updated_at: "2026-10-20T00:00:00Z", labels: ["human"] }),
    b("oldv", 2, "2026-10-01", { status: "in_progress", updated_at: "2026-10-20T00:00:00Z", labels: ["lane:v100"] }),
    b("oldf", 2, "2026-10-02", { status: "in_progress", updated_at: "2026-10-20T00:00:00Z", labels: ["lane:free"] }),
  ], none, NOW);
  expect(rows.map((r) => [r.id, r.title])).toEqual([["old", "[stale-claim] t-old"], ["oldf", "[stale-claim] t-oldf"]]);
});

test("pinned first, skipped hidden", () => {
  const rows = rank([b("a", 0, "2026-10-01"), b("b", 3, "2026-10-09"), b("c", 1, "2026-10-01")], [], { pin: ["b"], skip: ["c"] }, NOW);
  expect(rows.map((r) => [r.id, r.pinned])).toEqual([["b", true], ["a", false]]);
});

test("format: dir, id, P<pri>, [pinned] title, tab-separated; tabs in titles become spaces", () => {
  const rows = rank([b("a", 2, "2026-10-01", { title: "x\ty", dir: "/home/worker/repos" })], [], { pin: ["a"], skip: [] }, NOW);
  expect(format(rows)).toBe("/home/worker/repos\ta\tP2\t[pinned] x y");
  expect(format([])).toBe("");
});

test("unlabelled beads (bd omits labels) do not throw", () => {
  const nolab = (id: string, status: string) => ({ ...b(id, 1, "2026-10-01", { status, updated_at: "2026-10-01" }), labels: undefined }) as unknown as Bead;
  expect(ids(rank([nolab("r", "open")], [nolab("p", "in_progress")], none, NOW))).toEqual(["p", "r"]);
});

test("ties break on dir, id, title (the shell sort's whole-line order)", () => {
  const rows = rank([b("z", 1, "2026-10-01"), b("a", 1, "2026-10-01", { dir: "/s" }), b("m", 1, "2026-10-01")], [], none, NOW);
  expect(ids(rows)).toEqual(["m", "z", "a"]);
});

test("line breaks in a title cannot split a TSV row", () => {
  expect(format(rank([b("a", 1, "2026-10-01", { title: "x\r\ny\nz" })], [], none, NOW))).toBe("/r\ta\tP1\tx y z");
});

test("a bead with no priority field ranks as P0", () => {
  const p0 = { ...b("p", 0, "2026-10-09"), priority: undefined } as unknown as Bead;
  expect(ids(rank([b("a", 1, "2026-10-01"), p0], [], none, NOW))).toEqual(["p", "a"]);
});
