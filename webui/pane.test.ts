import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLACES, handle, inboxHtml, loadCards, loadConfig, shell, type Card, type Run } from "./pane";

// Control pane, slice B1: one screen (places | focus | assistant), five fixed places, Inbox read from beads.
// The framework is public: no repo, seat or mission names in code. They come from <config dir>/pane.json.

test("five fixed places, in order", () => {
  expect([...PLACES]).toEqual(["inbox", "feed", "seats", "work", "vision"]);
});

test("shell: three zones, places nav, active place, inbox count, phone viewport", () => {
  const html = shell("feed", "<p>hello</p>", { inbox: 3 });
  expect(html).toContain('name="viewport"');
  const at = PLACES.map((p) => html.indexOf(`href="/${p}"`));
  expect(at.every((i) => i > 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(html).toMatch(/<a[^>]*href="\/feed"[^>]*aria-current="page"/);
  expect(html).not.toMatch(/<a[^>]*href="\/inbox"[^>]*aria-current="page"/);
  expect(html).toMatch(/<main[^>]*id="focus"[^>]*>[\s\S]*<p>hello<\/p>[\s\S]*<\/main>/);
  expect(html).toMatch(/<aside[^>]*id="assistant"/);
  expect(html).toMatch(/href="\/inbox"[^>]*>[\s\S]{0,80}3/); // count sits on the inbox link
  expect(shell("inbox", "", { inbox: 0 })).not.toMatch(/href="\/inbox"[^>]*>[^<]*<[^>]*>0</); // no badge at zero
});

const fake = (lists: Record<string, unknown[] | number>): Run => async (a) => {
  const v = lists[a[1]!];
  if (typeof v === "number") return { code: v, out: "" };
  return { code: 0, out: JSON.stringify(v ?? []) };
};
const b = (id: string, priority: number, updated_at: string, status = "open") => ({ id, title: `t ${id}`, priority, status, updated_at });

test("loadCards: asks bd per dir, dedups, drops closed, sorts by priority then oldest, records failures", async () => {
  const calls: string[][] = [];
  const run: Run = async (a) => { calls.push(a); return fake({ "/a": [b("x-1", 2, "2026-11-02"), b("x-2", 0, "2026-11-05"), b("x-3", 1, "2026-11-01", "closed")], "/b": [b("x-1", 2, "2026-11-02"), b("y-9", 2, "2026-11-01")], "/c": 1 })(a); };
  const r = await loadCards(["/a", "/b", "/c"], run);
  expect(calls[0]).toEqual(["-C", "/a", "human", "list", "--json"]);
  expect(r.cards.map((c) => c.id)).toEqual(["x-2", "y-9", "x-1"]);
  expect(r.cards[1]).toMatchObject({ id: "y-9", title: "t y-9", priority: 2, source: "/b" });
  expect(r.errors.length).toBe(1);
  expect(r.errors[0]).toContain("/c");
});

test("inboxHtml: escapes titles, flags legacy items with source and date, has an empty state", () => {
  const cards: Card[] = [
    { id: "x-1", title: "<script>alert(1)</script>", priority: 1, updated: "2026-11-02", source: "/a" },
    { id: "prd-7", title: "old approval", priority: 2, updated: "2026-08-03", source: "ledger approvals", legacy: true },
  ];
  const html = inboxHtml(cards);
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toMatch(/legacy[\s\S]{0,60}ledger approvals[\s\S]{0,60}2026-08-03/);
  expect(html.match(/class="legacy"/g)!.length).toBe(1); // only the legacy card is flagged
  expect(inboxHtml([])).toContain("Nothing waiting on you");
});

test("loadConfig: reads pane.json from the given dir; fails closed, naming the path, when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pane-cfg-"));
  writeFileSync(join(dir, "pane.json"), JSON.stringify({ beadDirs: ["/a", "/b"] }));
  expect(loadConfig(dir).beadDirs).toEqual(["/a", "/b"]);
  const empty = mkdtempSync(join(tmpdir(), "pane-cfg-"));
  expect(() => loadConfig(empty)).toThrow(join(empty, "pane.json"));
});

test("handle: / goes to /inbox, each place answers, unknown is 404", async () => {
  const deps = { beadDirs: ["/a"], run: fake({ "/a": [b("x-1", 2, "2026-11-02")] }) };
  const root = await handle(new Request("http://h/"), deps);
  expect(root.status).toBe(302);
  expect(root.headers.get("location")).toBe("/inbox");
  const inbox = await handle(new Request("http://h/inbox"), deps);
  expect(inbox.status).toBe(200);
  expect(inbox.headers.get("content-type")).toContain("text/html");
  expect(await inbox.text()).toContain("t x-1");
  for (const p of ["feed", "seats", "work", "vision"]) expect((await handle(new Request(`http://h/${p}`), deps)).status).toBe(200);
  expect((await handle(new Request("http://h/nope"), deps)).status).toBe(404);
});
