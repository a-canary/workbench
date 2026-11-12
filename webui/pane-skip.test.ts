import { expect, test } from "bun:test";
import { loadCards, type Run } from "./pane";

// Skipping a card defers it until now, which leaves its status as `deferred` with a defer time in the past.
// A skipped card is still waiting for the operator: it stays in the inbox, behind the cards not yet seen.
// A card deferred to a later time, or with no time, is not due and stays out.

const item = (over: Record<string, unknown> = {}) => ({
  id: "a-1",
  title: "T",
  priority: 2,
  updated_at: "2026-01-01T00:00:00Z",
  status: "open",
  ...over,
});
const fake = (items: unknown[]): Run => async () => ({ code: 0, out: JSON.stringify(items) });
const NOW = Date.parse("2026-06-01T12:00:00Z");

test("loadCards: a skipped card (deferred, due) stays in the inbox; one deferred to later does not", async () => {
  const run = fake([
    item({ id: "a-1", status: "deferred", defer_until: "2026-06-01T11:59:00Z" }),
    item({ id: "a-2", status: "deferred", defer_until: "2026-06-01T12:00:00Z" }),
    item({ id: "a-3", status: "deferred", defer_until: "2026-06-02T00:00:00Z" }),
    item({ id: "a-4", status: "deferred" }),
    item({ id: "a-5", status: "deferred", defer_until: "soon" }),
    item({ id: "a-6", status: "deferred", defer_until: 5 }),
    item({ id: "a-7", status: "closed", defer_until: "2026-06-01T11:59:00Z" }),
  ]);
  const { cards, errors } = await loadCards(["/w"], run, NOW);
  expect(cards.map((c) => c.id)).toEqual(["a-1", "a-2"]);
  expect(cards.every((c) => c.skipped === true)).toBe(true);
  expect(errors).toEqual([]);
});

test("loadCards: skipped cards sort behind every card not yet seen, whatever their priority", async () => {
  const run = fake([
    item({ id: "s-1", priority: 0, status: "deferred", defer_until: "2026-05-01T00:00:00Z" }),
    item({ id: "o-1", priority: 3, updated_at: "2026-02-01T00:00:00Z" }),
    item({ id: "s-2", priority: 1, status: "deferred", defer_until: "2026-05-01T00:00:00Z" }),
    item({ id: "o-2", priority: 1, status: "in_progress" }),
  ]);
  const { cards } = await loadCards(["/w"], run, NOW);
  expect(cards.map((c) => c.id)).toEqual(["o-2", "o-1", "s-1", "s-2"]);
  expect(cards.map((c) => c.skipped === true)).toEqual([false, false, true, true]);
});

test("loadCards: the clock defaults to now", async () => {
  const run = fake([
    item({ id: "a-1", status: "deferred", defer_until: "2000-01-01T00:00:00Z" }),
    item({ id: "a-2", status: "deferred", defer_until: "2999-01-01T00:00:00Z" }),
  ]);
  const { cards } = await loadCards(["/w"], run);
  expect(cards.map((c) => c.id)).toEqual(["a-1"]);
});
