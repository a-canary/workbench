// wb-an0.5: driverPanel port from arc-webui src/dashboards/driver.ts — reuses sprint/log.ts, dashboard/fmt.ts, sprint/steer.ts.
import { describe, expect, test } from "bun:test";
import { sprints, type End, type Start } from "../sprint/log.ts";
import { driverPanel } from "./driver.ts";


const T0 = Date.parse("2026-10-27T20:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const start = (id: string, min: number, x: Partial<Start> = {}): Start => ({
  ev: "start", ts: at(min), lane: "claude", dir: "/r/trading", project: "trading", id, title: `t ${id}`, priority: 1, mem: [], ke: [], steer: [], ...x,
});
const end = (id: string, min: number, x: Partial<End> = {}): End => ({
  ev: "end", ts: at(min), lane: "claude", id, outcome: "done", finding: `f ${id}`, metrics: {}, mission: "", ...x,
});
const ctx = { deps: [], dependents: [], comments: [], missions: [], queue: [] };
const noSteer = { pin: [], skip: [], notes: [] };


describe("driverPanel", () => {
  const now = T0 + 140 * 60_000;
  test("live sprint, prep hits, trends, escaped text", () => {
    const evs = [
      start("a", 0), end("a", 50, { metrics: { nav: 1.5 }, finding: "<b>x</b>", mission: "trading: +nav" }),
      start("c", 60, { mem: [{ key: "status-trading", text: "m1" }], ke: [{ score: 46.8, title: "k1", path: "p/k1.md" }], steer: [{ ts: at(55), text: "go" }] }),
    ];
    const h = driverPanel("claude", sprints(evs, "claude", now), { ...ctx, missions: [{ slug: "trading", um: "UM-0200", problem: "p" }] }, noSteer, { now });
    expect(h).toContain("80 / 60 min — over timebox");
    expect(h).toContain("status-trading");
    expect(h).toContain("46.8%");
    expect(h).toContain("steering delivered: go");
    expect(h).toContain("UM-0200");
    expect(h).toContain("↗ trading: +nav");
    const other = sprints([...evs.slice(0, 2), start("x", 60, { project: "arc-skills" })], "claude", now);
    expect(driverPanel("claude", other, ctx, noSteer, { now }).split("Mission alignment")[1]!.split("History")[0]).not.toContain("+nav");
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(h).not.toContain("<b>x</b>");
  });
  test("project filter scopes findings; idle when nothing live", () => {
    const evs = [start("a", 0), end("a", 10), start("o", 20, { project: "app" }), end("o", 30)];
    const h = driverPanel("claude", sprints(evs, "claude", now), ctx, noSteer, { project: "app", now });
    expect(h).toContain("Idle");
    expect(h).toContain("f o");
    expect(h).not.toContain("f a");
  });
});
