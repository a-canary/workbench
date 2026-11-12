import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, loadCards, loadConfig, type Run } from "./pane";

// Control pane hardening (from merge review of the shell): one bad item or one failing workspace must not
// take the whole inbox down, config errors name the file, and the inbox count shows on every place.

const item = (over: Record<string, unknown> = {}) => ({
  id: "a-1",
  title: "T",
  priority: 2,
  updated_at: "2026-01-01T00:00:00Z",
  status: "open",
  ...over,
});
const fake = (byDir: Record<string, unknown[] | "throw">): Run => async (args) => {
  const v = byDir[args[1]!];
  if (v === "throw") throw new Error("spawn failed");
  return { code: 0, out: JSON.stringify(v ?? []) };
};

test("loadCards: a malformed item is skipped and reported; the rest of the inbox still loads", async () => {
  const run = fake({
    "/w1": [
      item({ id: "a-1" }),
      item({ id: "a-2", updated_at: undefined }),
      item({ id: "a-3", priority: "high" }),
      item({ id: 7 }),
      item({ id: "a-5", title: null }),
      "not an object",
      null,
    ],
    "/w2": [item({ id: "b-1", priority: 1 })],
  });
  const { cards, errors } = await loadCards(["/w1", "/w2"], run);
  expect(cards.map((c) => c.id)).toEqual(["b-1", "a-1"]);
  expect(errors).toEqual(["/w1: 6 malformed items skipped"]);
});

test("loadCards: a workspace whose command cannot start is reported, not thrown", async () => {
  const run = fake({ "/w1": "throw", "/w2": [item({ id: "b-1" })] });
  const { cards, errors } = await loadCards(["/w1", "/w2"], run);
  expect(cards.map((c) => c.id)).toEqual(["b-1"]);
  expect(errors).toEqual(["/w1: bd could not run"]);
});

test("loadCards: workspaces are asked at the same time, and results keep the configured order", async () => {
  let active = 0;
  let peak = 0;
  const run: Run = async (args) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, args[1] === "/w1" ? 20 : 5));
    active--;
    return { code: 0, out: JSON.stringify([item({ id: "same-1", title: args[1] })]) };
  };
  const { cards } = await loadCards(["/w1", "/w2", "/w3"], run);
  expect(peak).toBe(3);
  // The same bead seen from several workspaces is kept once, from the first configured one.
  expect(cards.map((c) => c.source)).toEqual(["/w1"]);
});

test("loadConfig: invalid JSON and a non-object config both fail naming the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pane-"));
  const path = join(dir, "pane.json");
  writeFileSync(path, "{ not json");
  expect(() => loadConfig(dir)).toThrow(path);
  writeFileSync(path, "null");
  expect(() => loadConfig(dir)).toThrow(path);
  writeFileSync(path, JSON.stringify({ beadDirs: ["/w1", 5] }));
  expect(() => loadConfig(dir)).toThrow(path);
  writeFileSync(path, JSON.stringify({ beadDirs: ["/w1"] }));
  expect(loadConfig(dir).beadDirs).toEqual(["/w1"]);
});

test("handle: the inbox count shows on the other places too", async () => {
  const run = fake({ "/w1": [item({ id: "a-1" }), item({ id: "a-2" })] });
  const res = await handle(new Request("http://x/feed"), { beadDirs: ["/w1"], run });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("inbox <b>2</b>");
});
