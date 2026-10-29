// Burn-rate start gate (wb-an0.4 FINAL SPEC, operator 2026-10-29 17:07Z): burn = util / elapsed_frac,
// start new Claude work only while burn < the silo's threshold.
import { test, expect } from "bun:test";
import type { Limit } from "./meter.ts";
import { burnGate } from "./burn.ts";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const inMin = (m: number) => new Date(NOW + m * 60_000).toISOString();
const L = (group: string, util: number, resetInMin: number | null, extra: Partial<Limit> = {}): Limit => ({
  kind: "k", group, util, reset: resetInMin == null ? null : inMin(resetInMin), active: true, scope: null, ...extra,
});
const start = (ls: Limit[], silo: string) => burnGate(ls, silo, NOW).start;

test("util < 0.20 allows every silo, even at the very start of the window", () => {
  const ls = [L("session", 0.19, 299)];
  for (const s of ["public", "dev", "app", "trading", "llc", "critical"]) expect(start(ls, s)).toBe(true);
});

test("session burn 1.0 (util 0.5, half the 300-min window left): only trading/llc/critical start", () => {
  const ls = [L("session", 0.5, 150)];
  expect(burnGate(ls, "public", NOW).burn).toBeCloseTo(1.0, 6);
  expect(start(ls, "public")).toBe(false);
  expect(start(ls, "dev")).toBe(false);
  expect(start(ls, "app")).toBe(false); // burn < threshold is strict
  expect(start(ls, "trading")).toBe(true);
  expect(start(ls, "llc")).toBe(true);
  expect(start(ls, "critical")).toBe(true);
});

test("burn 0.9: dev blocked at its own threshold, app starts", () => {
  const ls = [L("session", 0.45, 150)];
  expect(start(ls, "public")).toBe(false);
  expect(start(ls, "dev")).toBe(false);
  expect(start(ls, "app")).toBe(true);
});

test("weekly window is 7 days and the binding burn is the max over windows", () => {
  expect(start([L("session", 0.1, 100), L("weekly", 0.3, 5040)], "public")).toBe(true); // weekly burn 0.6
  const ls = [L("session", 0.1, 100), L("weekly", 0.45, 5040)]; // weekly burn 0.9
  expect(burnGate(ls, "dev", NOW).burn).toBeCloseTo(0.9, 6);
  expect(start(ls, "public")).toBe(false);
  expect(start(ls, "dev")).toBe(false);
  expect(start(ls, "trading")).toBe(true);
});

test("a window below 0.20 util does not bind even when its burn would be huge", () => {
  // session util 0.15 one minute in → burn 45, but util < 0.20 skips it; weekly burn 0.5 binds.
  const ls = [L("session", 0.15, 299), L("weekly", 0.25, 5040)];
  expect(burnGate(ls, "public", NOW).burn).toBeCloseTo(0.5, 6);
  expect(start(ls, "public")).toBe(true);
});

test("util >= 0.97 is a hard cap: critical only, whatever the burn", () => {
  const ls = [L("session", 0.97, 10)]; // burn ≈ 1.003 < trading 1.2, still capped
  const g = burnGate(ls, "trading", NOW);
  expect(g.start).toBe(false);
  expect(g.reason).toBe("hard-cap");
  expect(start(ls, "critical")).toBe(true);
});

test("critical is never gated by burn", () => {
  expect(start([L("session", 0.9, 290)], "critical")).toBe(true);
});

test("zero elapsed with util >= 0.20 is infinite burn; past or null reset counts as a fully elapsed window", () => {
  expect(start([L("session", 0.25, 300)], "trading")).toBe(false);
  expect(burnGate([L("session", 0.5, -5)], "dev", NOW).burn).toBeCloseTo(0.5, 6);
  expect(burnGate([L("session", 0.5, null)], "dev", NOW).burn).toBeCloseTo(0.5, 6);
});

test("inactive and model-scoped limits are ignored; none left = meter-unreachable, critical only", () => {
  const ls = [L("session", 0.9, 290, { active: false }), L("weekly", 0.9, 5000, { scope: "Opus" })];
  const g = burnGate(ls, "trading", NOW);
  expect(g.start).toBe(false);
  expect(g.reason).toBe("meter-unreachable");
  expect(g.burn).toBeNull();
  expect(start(ls, "critical")).toBe(true);
  expect(start([L("session", Number.NaN, 100)], "trading")).toBe(false);
});

test("an unknown silo gets the strictest (public) threshold", () => {
  const ls = [L("session", 0.425, 150)]; // burn 0.85
  expect(start(ls, "public")).toBe(false);
  expect(start(ls, "mystery")).toBe(false);
  expect(start(ls, "dev")).toBe(true);
});
