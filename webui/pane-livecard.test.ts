import { expect, test } from "bun:test";
import { applyDecision, inboxHtml, type Run } from "./pane";

// A verdict is checked against the card as it is now, not as it was when the page was drawn:
// the card must still be waiting for the operator, and an accepted option must be one the card offers.
// This also stops a second submit of the same form from writing a second verdict.

const CARD = `<decide><q>Ship?</q><context>Tests pass.</context><option id="A" rec="1" title="Ship now">Fast.</option><option id="B" title="Wait a day">Safer.</option></decide>`;

type Shown = { code: number; out: string };
const waiting = (description: string, labels: unknown = ["human"]): Shown => ({
  code: 0,
  out: JSON.stringify([{ id: "x-1", labels, description }]),
});
const bd = (shown: Shown) => {
  const calls: string[][] = [];
  const run: Run = async (a) => {
    calls.push(a);
    return a[2] === "show" ? shown : { code: 0, out: "" };
  };
  const writes = () => calls.filter((c) => c[2] !== "show");
  return { calls, writes, run };
};
const decide = (action: string, shown: Shown, text = "") => {
  const b = bd(shown);
  return applyDecision({ dir: "/a", id: "x-1", action, text }, ["/a"], b.run).then((err) => ({ err, ...b }));
};

test("applyDecision reads the card first, then writes", async () => {
  const r = await decide("accept:B", waiting(CARD));
  expect(r.err).toBeNull();
  expect(r.calls[0]).toEqual(["-C", "/a", "show", "x-1", "--json"]);
  expect(r.writes().length).toBe(2);
});

test("applyDecision: a card that cannot be read gets no verdict", async () => {
  for (const shown of [{ code: 1, out: "" }, { code: 0, out: "not json" }, { code: 0, out: "[]" }, { code: 0, out: "{}" }]) {
    const r = await decide("accept:A", shown);
    expect(r.err).toBe("card not found");
    expect(r.writes().length).toBe(0);
  }
});

test("applyDecision: a card that is no longer waiting gets no second verdict", async () => {
  for (const labels of [["decided"], [], null, "human"]) {
    for (const action of ["accept:A", "reject", "defer"]) {
      const r = await decide(action, waiting(CARD, labels));
      expect(r.err).toBe("card is no longer waiting");
      expect(r.writes().length).toBe(0);
    }
  }
});

test("applyDecision: accept must name one of the card's own options; reject, reply and skip need none", async () => {
  const other = await decide("accept:C", waiting(CARD));
  expect(other.err).toBe("not one of this card's options");
  expect(other.writes().length).toBe(0);

  const bare = await decide("accept", waiting(CARD));
  expect(bare.err).toBe("pick one of the card's options");
  expect(bare.writes().length).toBe(0);

  expect((await decide("reject", waiting(CARD))).err).toBeNull();
  expect((await decide("defer", waiting(CARD), "what about C?")).err).toBeNull();
  expect((await decide("defer", waiting(CARD))).err).toBeNull();
});

test("applyDecision: a card with no options, or a malformed one, takes a plain accept and no option letter", async () => {
  for (const description of ["just some prose", "<decide><q>No end?</q>", undefined as unknown as string]) {
    expect((await decide("accept", waiting(description))).err).toBeNull();
    const lettered = await decide("accept:A", waiting(description));
    expect(lettered.err).toBe("not one of this card's options");
    expect(lettered.writes().length).toBe(0);
  }
});

test("inboxHtml: a malformed card says so instead of looking like a plain card", () => {
  const card = { id: "x-1", title: "T", priority: 2, updated: "2026-01-01T00:00:00Z", source: "/a" };
  const html = inboxHtml([{ ...card, description: "<decide><q>No end?</q>" }]);
  expect(html).toContain("card format problem");
  expect(inboxHtml([{ ...card, description: "just some prose" }])).not.toContain("card format problem");
  expect(inboxHtml([{ ...card, description: CARD }])).not.toContain("card format problem");
});
