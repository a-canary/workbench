// Sprint log: pair start/end events (sprints.jsonl) into Sprints for the driver dashboard.
import { test, expect } from "bun:test";
import { sprints, live, trends, type Start, type End } from "./log.ts";

const st = (id: string, ts: string, lane = "claude"): Start => ({
  ev: "start", ts, lane, dir: "/r", project: "p", id, title: `t-${id}`, priority: 2, mem: [], ke: [], steer: [],
});
const en = (id: string, ts: string, metrics: Record<string, number> = {}, extra: Partial<End> = {}): End => ({
  ev: "end", ts, lane: "claude", id, outcome: "done", finding: "f", metrics, mission: "", ...extra,
});
const T = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();

test("pairs an end with its start and measures minutes", () => {
  const [s] = sprints([st("a", T(0)), en("a", T(42))], "claude");
  expect(s.id).toBe("a");
  expect(s.end?.outcome).toBe("done");
  expect(s.minutes).toBe(42);
});

test("open sprint runs to now and is live", () => {
  const sp = sprints([st("a", T(0)), en("a", T(5)), st("b", T(10))], "claude", Date.parse(T(25)));
  expect(sp.map((s) => s.id)).toEqual(["b", "a"]); // newest first
  expect(sp[0].minutes).toBe(15);
  expect(live(sp)?.id).toBe("b");
  expect(live(sp.slice(1))).toBeUndefined();
});

test("end closes the LATEST open start of the same id", () => {
  const sp = sprints([st("a", T(0)), st("a", T(30)), en("a", T(40))], "claude", Date.parse(T(50)));
  const closed = sp.find((s) => s.end)!;
  expect(closed.ts).toBe(T(30));
  expect(closed.minutes).toBe(10);
  expect(sp.find((s) => !s.end)?.minutes).toBe(50);
});

test("end without a start becomes a sprint of unknown length", () => {
  const [s] = sprints([en("x", T(3), {}, { project: "q", title: "orphan" })], "claude");
  expect(s.id).toBe("x");
  expect(s.project).toBe("q");
  expect(s.title).toBe("orphan");
  expect(Number.isNaN(s.minutes)).toBe(true);
  expect(s.end?.id).toBe("x");
});

test("other lanes are ignored", () => {
  expect(sprints([st("a", T(0), "v100")], "claude")).toEqual([]);
});

test("trends: per-metric series oldest to newest, finite values only", () => {
  const sp = sprints([
    st("a", T(0)), en("a", T(1), { pass: 0.5 }),
    st("b", T(2)), en("b", T(3), { pass: 0.7, bad: NaN }),
  ], "claude");
  expect(trends(sp)).toEqual([{ name: "pass", vals: [0.5, 0.7], ids: ["a", "b"] }]);
});
