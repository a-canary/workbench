// Claude budget gate: parse the oauth usage response, take the binding util, decide claude vs local-lane-first.
import { test, expect } from "bun:test";
import { parseUsage, meterOf, budgetGate } from "./meter.ts";

const usage = (limits: object[]) => ({ limits });
const L = (group: string, percent: unknown, extra: object = {}) => ({ kind: "k", group, percent, resets_at: "2026-10-28T16:50:00Z", is_active: true, ...extra });

test("parseUsage: percent -> 0..1 util, scope from model display name, missing fields tolerated", () => {
  expect(parseUsage(usage([L("session", 41), L("weekly", 12, { is_active: false, scope: { model: { display_name: "Opus" } } })]))).toEqual([
    { kind: "k", group: "session", util: 0.41, reset: "2026-10-28T16:50:00Z", active: true, scope: null },
    { kind: "k", group: "weekly", util: 0.12, reset: "2026-10-28T16:50:00Z", active: false, scope: "Opus" },
  ]);
  expect(parseUsage({})).toEqual([]);
  expect(parseUsage(null)).toEqual([]);
  const [x] = parseUsage(usage([{ group: "session", percent: "41" }]));
  expect(x!.util).toBeNaN();
  expect(x!.reset).toBeNull();
  expect(x!.active).toBe(false);
});

test("meterOf: max over active unscoped session/weekly limits", () => {
  const ls = parseUsage(usage([
    L("session", 41), L("weekly", 70), L("weekly", 99, { is_active: false }),
    L("weekly", 100, { scope: { model: { display_name: "Opus" } } }), L("other", 100),
  ]));
  expect(meterOf(ls)).toEqual({ util: 0.7, limited: false });
  expect(meterOf(parseUsage(usage([L("session", 100)])))).toEqual({ util: 1, limited: true });
});

test("meterOf: null when nothing qualifies or any qualifying util is garbled", () => {
  expect(meterOf([])).toBeNull();
  expect(meterOf(parseUsage(usage([L("session", 41, { is_active: false })])))).toBeNull();
  expect(meterOf(parseUsage(usage([L("session", 41), L("weekly", "x")])))).toBeNull();
});

test("budgetGate: under threshold runs claude", () => {
  expect(budgetGate({ util: 0.41, limited: false }, 5)).toEqual({ claude: true, reason: "ok" });
});

test("budgetGate: at/over threshold is local-first until the local queue is empty", () => {
  expect(budgetGate({ util: 0.9, limited: false }, 2)).toEqual({ claude: false, reason: "local-first" });
  expect(budgetGate({ util: 0.95, limited: false }, 0)).toEqual({ claude: true, reason: "local-first" });
  expect(budgetGate({ util: 0.85, limited: false }, 2, 0.8)).toEqual({ claude: false, reason: "local-first" });
});

test("budgetGate: limited never runs claude; unreachable meter fails closed to local-first", () => {
  expect(budgetGate({ util: 1, limited: true }, 0)).toEqual({ claude: false, reason: "limited" });
  expect(budgetGate(null, 3)).toEqual({ claude: false, reason: "meter-unreachable" });
  expect(budgetGate(null, 0)).toEqual({ claude: true, reason: "meter-unreachable" });
});
