import { expect, test } from "bun:test";
import { applyDecision, inboxHtml, type Run } from "./pane";

// From merge review: (1) a card that already carries `decided` takes no second verdict, even when a failed
// label step left `human` on it; (2) two submits for the same card at the same moment write one verdict;
// (3) text an agent put outside the decide block (its evidence) is shown, not hidden.

const CARD = `<decide><q>Ship?</q><context>Tests pass.</context><option id="A" rec="1" title="Ship now">Fast.</option><option id="B" title="Wait a day">Safer.</option></decide>`;
const shown = (labels: string[]) => ({ code: 0, out: JSON.stringify([{ id: "x-1", labels, description: CARD }]) });
const input = (over: Record<string, string> = {}) => ({ dir: "/a", id: "x-1", action: "accept:A", text: "", ...over });

test("applyDecision: a card that already carries decided takes no second verdict", async () => {
  for (const action of ["accept:B", "reject", "defer"]) {
    const calls: string[][] = [];
    const run: Run = async (a) => {
      calls.push(a);
      return a[2] === "show" ? shown(["human", "decided"]) : { code: 0, out: "" };
    };
    expect(await applyDecision(input({ action }), ["/a"], run)).toBe("card is already decided");
    expect(calls.filter((c) => c[2] !== "show").length).toBe(0);
  }
});

test("applyDecision: two submits for the same card at the same moment write one verdict", async () => {
  const calls: string[][] = [];
  let open!: () => void;
  const held = new Promise<void>((r) => (open = r));
  const run: Run = async (a) => {
    calls.push(a);
    if (a[2] !== "show") return { code: 0, out: "" };
    await held;
    return shown(["human"]);
  };
  const first = applyDecision(input(), ["/a"], run);
  // The first submit is still reading the card. A second one for the same card is refused at once.
  expect(await applyDecision(input({ action: "accept:B" }), ["/a"], run)).toBe("card is being decided");
  expect(calls.length).toBe(1);
  // Another card, and the same id in another workspace, are not held up: each gets its own read.
  const other = applyDecision(input({ id: "x-2" }), ["/a"], run);
  const elsewhere = applyDecision(input({ dir: "/b" }), ["/a", "/b"], run);
  expect(calls.filter((c) => c[2] === "show").length).toBe(3);
  open();
  expect(await first).toBeNull();
  expect(await other).toBeNull();
  expect(await elsewhere).toBeNull();
  expect(calls.filter((c) => c[2] === "comments").length).toBe(3);
});

test("applyDecision: the hold on a card is released when the verdict is done, refused or fails", async () => {
  const ok: Run = async (a) => (a[2] === "show" ? shown(["human"]) : { code: 0, out: "" });
  const failing: Run = async (a) => (a[2] === "show" ? shown(["human"]) : { code: 1, out: "" });
  const thrower: Run = async () => {
    throw new Error("spawn failed");
  };
  expect(await applyDecision(input(), ["/a"], ok)).toBeNull();
  expect(await applyDecision(input({ action: "accept:C" }), ["/a"], ok)).toBe("not one of this card's options");
  expect(await applyDecision(input(), ["/a"], failing)).not.toBeNull();
  await applyDecision(input(), ["/a"], thrower).catch(() => "threw");
  // After each of those the card can be decided again.
  expect(await applyDecision(input(), ["/a"], ok)).toBeNull();
});

test("inboxHtml: text outside the decide block is shown, escaped, before the buttons", () => {
  const card = { id: "x-1", title: "T", priority: 2, updated: "2026-01-01T00:00:00Z", source: "/a" };
  const html = inboxHtml([{ ...card, description: `Intro line.\n${CARD}\nEvidence: run 12 <b>ok</b>` }]);
  expect(html).toContain(`<pre class="tail">Intro line.\n\nEvidence: run 12 &lt;b&gt;ok&lt;/b&gt;</pre>`);
  expect(html.indexOf(`class="tail"`)).toBeLessThan(html.indexOf("<form"));
  expect(html).not.toContain("<b>ok</b>");
  expect(inboxHtml([{ ...card, description: CARD }])).not.toContain(`class="tail"`);
  expect(inboxHtml([{ ...card, description: "just some prose" }])).not.toContain(`class="tail"`);
});
