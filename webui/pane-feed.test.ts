import { expect, test } from "bun:test";
import { feedHtml, handle, loadLanded, type Landed, type Run } from "./pane";

// Control pane, slice D1: the Feed place lists what landed. A landed item is a closed bead; its line is
// the title plus the close reason the closer wrote, so no model is needed to say what happened.

const NOW = Date.parse("2026-11-12T12:00:00Z");
const c = (id: string, closed_at: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `t ${id}`,
  issue_type: "task",
  status: "closed",
  closed_at,
  close_reason: `r ${id}`,
  ...extra,
});

test("loadLanded: asks bd per dir for beads closed in the window, newest first, dedups, records failures", async () => {
  const calls: string[][] = [];
  const run: Run = async (a) => {
    calls.push(a);
    if (a[1] === "/a") return { code: 0, out: JSON.stringify([c("x-1", "2026-11-11T09:00:00Z"), c("x-2", "2026-11-12T08:00:00Z")]) };
    if (a[1] === "/b") return { code: 0, out: JSON.stringify([c("y-9", "2026-11-12T07:30:00Z", { issue_type: "decision" }), c("x-1", "2026-11-11T09:00:00Z")]) };
    return { code: 1, out: "" };
  };
  const r = await loadLanded(["/a", "/b", "/c"], run, NOW);
  expect(calls[0]).toEqual(["-C", "/a", "list", "--status", "closed", "--closed-after", "2026-11-09T12:00:00.000Z", "--limit", "0", "--json"]);
  expect(r.items.map((i) => i.id)).toEqual(["x-2", "y-9", "x-1"]);
  expect(r.items[1]).toEqual({ id: "y-9", title: "t y-9", kind: "decision", closed: "2026-11-12T07:30:00Z", reason: "r y-9", source: "/b" });
  expect(r.errors.length).toBe(1);
  expect(r.errors[0]).toContain("/c");
});

test("loadLanded: the window is a parameter; malformed rows are counted, not shown; a missing reason is empty", async () => {
  const calls: string[][] = [];
  const run: Run = async (a) => {
    calls.push(a);
    return { code: 0, out: JSON.stringify([{ id: "z-1" }, null, c("z-2", "2026-11-12T01:00:00Z", { close_reason: undefined })]) };
  };
  const r = await loadLanded(["/a"], run, NOW, 1);
  expect(calls[0]![6]).toBe("2026-11-11T12:00:00.000Z");
  expect(r.items.map((i) => i.id)).toEqual(["z-2"]);
  expect(r.items[0]!.reason).toBe("");
  expect(r.errors).toEqual(["/a: 2 malformed items skipped"]);
});

test("loadLanded: bad JSON and a run that throws are failures, not an empty feed", async () => {
  const run: Run = async (a) => {
    if (a[1] === "/a") return { code: 0, out: "not json" };
    throw new Error("spawn failed");
  };
  const r = await loadLanded(["/a", "/b"], run, NOW);
  expect(r.items).toEqual([]);
  expect(r.errors.length).toBe(2);
});

const item = (id: string, closed: string, source: string, extra: Partial<Landed> = {}): Landed => ({
  id,
  title: `t ${id}`,
  kind: "task",
  closed,
  reason: `r ${id}`,
  source,
  ...extra,
});

test("feedHtml: one heading per day, newest first; each line has time, place, id, title and reason", () => {
  const html = feedHtml([
    item("x-2", "2026-11-12T08:05:00Z", "/work/alpha"),
    item("y-9", "2026-11-12T07:30:00Z", "/work/beta"),
    item("x-1", "2026-11-11T09:00:00Z", "/work/alpha"),
  ]);
  expect(html.match(/<h2>/g)?.length).toBe(2);
  expect(html.indexOf("<h2>2026-11-12</h2>")).toBeGreaterThanOrEqual(0);
  expect(html.indexOf("<h2>2026-11-12</h2>")).toBeLessThan(html.indexOf("<h2>2026-11-11</h2>"));
  expect(html.indexOf("x-2")).toBeLessThan(html.indexOf("y-9"));
  expect(html.indexOf("y-9")).toBeLessThan(html.indexOf("x-1"));
  expect(html).toContain("08:05");
  expect(html).toContain("alpha");
  expect(html).not.toContain("/work/alpha"); // the place is the last path part, not the whole path
  expect(html).toContain("t x-2");
  expect(html).toContain("r x-2");
});

test("feedHtml: text from beads is escaped", () => {
  const html = feedHtml([item("x-1", "2026-11-12T08:05:00Z", "/a", { title: "<script>t</script>", reason: '<img src=x onerror="1">' })]);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
});

test("feedHtml: a place filter keeps only that place; filter links carry counts and mark the active one", () => {
  const items = [
    item("x-2", "2026-11-12T08:05:00Z", "/work/alpha"),
    item("y-9", "2026-11-12T07:30:00Z", "/work/beta"),
    item("x-1", "2026-11-11T09:00:00Z", "/work/alpha"),
  ];
  const all = feedHtml(items);
  expect(all).toMatch(/href="\/feed\?place=alpha"[^>]*>alpha 2</);
  expect(all).toMatch(/href="\/feed\?place=beta"[^>]*>beta 1</);
  expect(all).toMatch(/href="\/feed"[^>]*aria-current="page"[^>]*>all 3</);
  const one = feedHtml(items, "alpha");
  expect(one).toContain("x-2");
  expect(one).toContain("x-1");
  expect(one).not.toContain("y-9");
  expect(one).toMatch(/href="\/feed\?place=alpha"[^>]*aria-current="page"/);
  expect(one).toMatch(/href="\/feed\?place=beta"[^>]*>beta 1</); // other places stay reachable, with their counts
});

test("feedHtml: says so when nothing landed", () => {
  expect(feedHtml([])).toContain("Nothing landed");
});

const paneRun: Run = async (a) => {
  if (a[2] === "human") return { code: 0, out: "[]" };
  if (a[2] === "list" && a[1] === "/a") return { code: 0, out: JSON.stringify([c("x-2", "2026-11-12T08:00:00Z")]) };
  return { code: 1, out: "" };
};

test("GET /feed: the feed renders in the shell; a failed place shows as a warning, never as an empty feed", async () => {
  const res = await handle(new Request("http://pane.test/feed"), { beadDirs: ["/a", "/b"], run: paneRun });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toMatch(/<a[^>]*href="\/feed"[^>]*aria-current="page"/);
  expect(html).toContain("t x-2");
  expect(html).toContain("r x-2");
  expect(html).not.toContain("not built yet</p></main>");
  expect(html).toMatch(/class="warn"[^>]*>[^<]*\/b/);
});

test("GET /feed?place=: filters by place; an unknown place shows nothing landed", async () => {
  const hit = await (await handle(new Request("http://pane.test/feed?place=a"), { beadDirs: ["/a"], run: paneRun })).text();
  expect(hit).toContain("t x-2");
  const miss = await (await handle(new Request("http://pane.test/feed?place=nope"), { beadDirs: ["/a"], run: paneRun })).text();
  expect(miss).not.toContain("t x-2");
  expect(miss).toContain("Nothing landed");
});
