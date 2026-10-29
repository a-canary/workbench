// wb-an0.5 slice 2: driverPanel renders the bead context (deps, dependents, queue, comments),
// caps History at the 15 most recent sprints, and survives a ke hit without a score.
import { describe, expect, test } from "bun:test";
import { sprints, type End, type Start } from "../sprint/log.ts";
import { driverPanel, type Ctx } from "./driver.ts";

const T0 = Date.parse("2026-10-27T20:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const start = (id: string, min: number, x: Partial<Start> = {}): Start => ({
  ev: "start", ts: at(min), lane: "claude", dir: "/r/trading", project: "trading", id, title: `t ${id}`, priority: 1, mem: [], ke: [], steer: [], ...x,
});
const end = (id: string, min: number, x: Partial<End> = {}): End => ({
  ev: "end", ts: at(min), lane: "claude", id, outcome: "done", finding: `f ${id}`, metrics: {}, mission: "", ...x,
});
const empty: Ctx = { deps: [], dependents: [], comments: [], missions: [], queue: [] };
const noSteer = { pin: [], skip: [], notes: [] };
const now = T0 + 600 * 60_000;
const panel = (ctx: Ctx, evs: (Start | End)[] = []) => driverPanel("claude", sprints(evs, "claude", now), ctx, noSteer, { now });

describe("driverPanel bead context", () => {
  test("deps, dependents and queue each get a section of linked, escaped rows", () => {
    const h = panel({
      ...empty,
      deps: [{ id: "wb-d1", title: "dep <one>", status: "closed" }],
      dependents: [{ id: "wb-u1", title: "needs me" }],
      queue: [{ id: "wb-q1", title: "next up" }, { id: "wb-q2", title: "after that" }],
    });
    expect(h).toContain("<h3>Depends on</h3>");
    expect(h).toContain('<a href="#wb-d1">wb-d1</a> — dep &lt;one&gt;');
    expect(h).toContain(">closed</span>");
    expect(h).toContain("<h3>Dependents</h3>");
    expect(h).toContain('<a href="#wb-u1">wb-u1</a> — needs me');
    expect(h).toContain("<h3>Queue</h3>");
    expect(h.indexOf("wb-q1")).toBeLessThan(h.indexOf("wb-q2"));
  });

  test("empty context renders none of those sections", () => {
    const h = panel(empty);
    for (const s of ["Depends on", "Dependents", "Queue", "Comments"]) expect(h).not.toContain(`<h3>${s}</h3>`);
  });

  test("comments show author, age and escaped text", () => {
    const h = panel({ ...empty, comments: [{ ts: at(540), author: "op", text: "ship <it>" }] });
    expect(h).toContain("<h3>Comments</h3>");
    expect(h).toContain("op");
    expect(h).toContain("1h ago");
    expect(h).toContain("ship &lt;it&gt;");
  });

  test("History keeps only the 15 most recent ended sprints", () => {
    const evs: (Start | End)[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `x${String(i).padStart(2, "0")}`;
      evs.push(start(id, i * 20), end(id, i * 20 + 10));
    }
    const h = panel(empty, evs);
    expect(h).not.toContain("id: x04");
    expect(h).toContain("id: x05");
    expect(h).toContain("id: x19");
    expect(h.split('class="dr-sprint"').length - 1).toBe(15);
  });

  test("a knowledge hit without a score renders instead of throwing", () => {
    const ke = [{ title: "k-noscore", path: "p.md" } as unknown as { score: number; title: string; path: string }];
    const h = panel(empty, [start("live", 590, { ke })]);
    expect(h).toContain("k-noscore");
    expect(h).not.toContain("NaN");
  });
});
