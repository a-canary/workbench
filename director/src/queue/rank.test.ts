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
  ], none, NOW);
  expect(rows.map((r) => [r.id, r.title])).toEqual([["old", "[stale-claim] t-old"]]);
});

test("pinned first, skipped hidden", () => {
  const rows = rank([b("a", 0, "2026-10-01"), b("b", 3, "2026-10-09"), b("c", 1, "2026-10-01")], [], { pin: ["b"], skip: ["c"] }, NOW);
  expect(rows.map((r) => [r.id, r.pinned])).toEqual([["b", true], ["a", false]]);
});

test("format: dir, id, P<pri>, [pinned] title, tab-separated; tabs in titles become spaces", () => {
  const rows = rank([b("a", 2, "2026-10-01", { title: "x\ty", dir: "/home/u/repos" })], [], { pin: ["a"], skip: [] }, NOW);
  expect(format(rows)).toBe("/home/u/repos\ta\tP2\t[pinned] x y");
  expect(format([])).toBe("");
});
