import { expect, test } from "bun:test";
import { applyDecision, handle, inboxHtml, loadCards, parseDecide, sameOrigin, type Card, type Run } from "./pane";

// Control pane, slice B2a: act on an Inbox card. A verdict is written to the bead as a
// "DECISION <verb>[ <option>][: <note>]" comment and the bead's label moves human -> decided,
// which is what agents poll for. Order matters: a failed step must leave the card in the Inbox.

const CARD = `<decide><q>Ship the <b>thing</b>?</q><context>Tests pass.</context><option id="A" rec="1" title="Ship now">Fast, small risk.</option><option id="B" title="Wait a day">Safer, slower.</option></decide>

Evidence: run 12`;

const recorder = (fail?: (a: string[]) => boolean) => {
  const calls: string[][] = [];
  const run: Run = async (a) => { calls.push(a); return { code: fail?.(a) ? 1 : 0, out: "[]" }; };
  return { calls, run };
};

test("parseDecide: question, context, options and the recommendation; null without a card; error when malformed", () => {
  const d = parseDecide(CARD) as Exclude<ReturnType<typeof parseDecide>, null | { error: string }>;
  expect(d.q).toBe("Ship the <b>thing</b>?");
  expect(d.context).toBe("Tests pass.");
  expect(d.options.map((o) => [o.id, o.title, o.rec])).toEqual([["A", "Ship now", true], ["B", "Wait a day", false]]);
  expect(d.options[1]!.body).toBe("Safer, slower.");
  expect(d.tail).toBe("Evidence: run 12");
  expect(parseDecide("just some prose")).toBeNull();
  expect(parseDecide('<decide><q>One?</q><option id="A" title="Only">x</option></decide>')).toHaveProperty("error");
  expect(parseDecide("<decide><q>No end?</q>")).toHaveProperty("error");
});

test("loadCards keeps the bead description on the card", async () => {
  const run: Run = async () => ({ code: 0, out: JSON.stringify([{ id: "x-1", title: "t", priority: 1, status: "open", updated_at: "2026-11-02", description: CARD }]) });
  const r = await loadCards(["/a"], run);
  expect(r.cards[0]!.description).toBe(CARD);
});

test("inboxHtml: a card shows its question and one accept button per option, in a form that posts the verdict", () => {
  const cards: Card[] = [{ id: "x-1", title: "ship?", priority: 1, updated: "2026-11-02", source: "/a", description: CARD }];
  const html = inboxHtml(cards);
  expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/inbox\/decide"/i);
  expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="dir"[^>]*value="\/a"/);
  expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="id"[^>]*value="x-1"/);
  expect(html).toContain("Ship the &lt;b&gt;thing&lt;/b&gt;?"); // card text is escaped, never raw HTML
  expect(html).not.toContain("<b>thing</b>");
  expect(html).toContain("Tests pass.");
  expect(html).toMatch(/<button[^>]*name="action"[^>]*value="accept:A"[^>]*>[\s\S]*?Ship now[\s\S]*?<\/button>/);
  expect(html).toMatch(/<button[^>]*name="action"[^>]*value="accept:B"[^>]*>[\s\S]*?Wait a day[\s\S]*?<\/button>/);
  expect(html.match(/class="rec"/g)!.length).toBe(1); // only the recommended option is marked
  expect(html.indexOf('class="rec"')).toBeLessThan(html.indexOf('value="accept:B"'));
  expect(html).toMatch(/<textarea[^>]*name="text"/);
  expect(html).toMatch(/<button[^>]*name="action"[^>]*value="reject"/);
  expect(html).toMatch(/<button[^>]*name="action"[^>]*value="defer"/); // reply (with a note) or skip (without)
});

test("inboxHtml: a card with no decide block shows its text escaped and a plain accept button", () => {
  const html = inboxHtml([{ id: "x-2", title: "old style", priority: 2, updated: "2026-11-02", source: "/a", description: "Do <i>this</i>?" }]);
  expect(html).toContain("Do &lt;i&gt;this&lt;/i&gt;?");
  expect(html).toMatch(/<button[^>]*name="action"[^>]*value="accept"[^>]*>/);
  expect(html).not.toMatch(/value="accept:[A-E]"/);
});

test("applyDecision accept: adds decided, writes the DECISION comment, only then drops human", async () => {
  const { calls, run } = recorder();
  expect(await applyDecision({ dir: "/a", id: "x-1", action: "accept:B", text: " go slow " }, ["/a"], run)).toBeNull();
  expect(calls).toEqual([
    ["-C", "/a", "label", "add", "x-1", "decided"],
    ["-C", "/a", "comments", "add", "--author", "operator", "--", "x-1", "DECISION accept B: go slow"],
    ["-C", "/a", "label", "remove", "x-1", "human"],
  ]);
});

test("applyDecision reject, reply and skip", async () => {
  const rej = recorder();
  expect(await applyDecision({ dir: "/a", id: "x-1", action: "reject", text: "" }, ["/a"], rej.run)).toBeNull();
  expect(rej.calls[1]!.at(-1)).toBe("DECISION reject");
  expect(rej.calls.length).toBe(3);

  const reply = recorder(); // defer with a note is a reply: decided, leaves the inbox
  expect(await applyDecision({ dir: "/a", id: "x-1", action: "defer", text: "what about C?" }, ["/a"], reply.run)).toBeNull();
  expect(reply.calls.map((c) => c.slice(2))).toEqual([
    ["label", "add", "x-1", "decided"],
    ["comments", "add", "--author", "operator", "--", "x-1", "DECISION reply: what about C?"],
    ["label", "remove", "x-1", "human"],
  ]);

  const skip = recorder(); // defer with no note is a skip: stays a human card, goes to the back
  expect(await applyDecision({ dir: "/a", id: "x-1", action: "defer", text: "" }, ["/a"], skip.run)).toBeNull();
  expect(skip.calls.map((c) => c.slice(2))).toEqual([
    ["defer", "x-1", "--until=now"],
    ["comments", "add", "--author", "operator", "--", "x-1", "DECISION skip"],
  ]);
});

test("applyDecision refuses bad input without calling bd, and stops at the first failed step", async () => {
  const { calls, run } = recorder();
  expect(await applyDecision({ dir: "/elsewhere", id: "x-1", action: "accept", text: "" }, ["/a"], run)).toBe("unknown workspace");
  expect(await applyDecision({ dir: "/a", id: "--help", action: "accept", text: "" }, ["/a"], run)).toBe("bad bead id");
  expect(await applyDecision({ dir: "/a", id: "x 1; rm", action: "accept", text: "" }, ["/a"], run)).toBe("bad bead id");
  expect(await applyDecision({ dir: "/a", id: "x-1", action: "launch", text: "" }, ["/a"], run)).toBe("bad action");
  expect(await applyDecision({ dir: "/a", id: "x-1", action: "reject:B", text: "" }, ["/a"], run)).toBe("bad option");
  expect(await applyDecision({ dir: "/a", id: "x-1", action: "accept:Z", text: "" }, ["/a"], run)).toBe("bad option");
  expect(calls.length).toBe(0);

  const broken = recorder((a) => a[2] === "comments");
  const err = await applyDecision({ dir: "/a", id: "x-1", action: "accept:A", text: "" }, ["/a"], broken.run);
  expect(err).toContain("comments");
  expect(broken.calls.some((c) => c[2] === "label" && c[3] === "remove")).toBe(false); // card stays in the inbox
});

test("sameOrigin: browsers posting from another site are refused; clients that send neither header pass", () => {
  const h = (m: Record<string, string>) => (k: string) => m[k];
  expect(sameOrigin(h({}), "pane:8081")).toBe(true);
  expect(sameOrigin(h({ "sec-fetch-site": "same-origin", origin: "http://pane:8081" }), "pane:8081")).toBe(true);
  expect(sameOrigin(h({ "sec-fetch-site": "cross-site" }), "pane:8081")).toBe(false);
  expect(sameOrigin(h({ origin: "http://evil.example" }), "pane:8081")).toBe(false);
  expect(sameOrigin(h({ origin: "http://pane:8081" }), undefined)).toBe(false);
});

const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request("http://pane:8081/inbox/decide", { method: "POST", headers: { host: "pane:8081", "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });

test("handle POST /inbox/decide: applies the verdict and returns to the inbox; refuses cross-site, bad input and GET", async () => {
  const ok = recorder();
  const res = await handle(post({ dir: "/a", id: "x-1", action: "accept:A", text: "" }), { beadDirs: ["/a"], run: ok.run });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/inbox");
  expect(ok.calls.at(-1)).toEqual(["-C", "/a", "label", "remove", "x-1", "human"]);

  const cross = recorder();
  const blocked = await handle(post({ dir: "/a", id: "x-1", action: "accept:A", text: "" }, { "sec-fetch-site": "cross-site" }), { beadDirs: ["/a"], run: cross.run });
  expect(blocked.status).toBe(403);
  expect(cross.calls.length).toBe(0);

  const bad = recorder();
  const refused = await handle(post({ dir: "/a", id: "x-1", action: "launch", text: "" }), { beadDirs: ["/a"], run: bad.run });
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("bad action");
  expect(bad.calls.length).toBe(0);

  expect((await handle(new Request("http://pane:8081/inbox/decide"), { beadDirs: ["/a"], run: ok.run })).status).toBe(405);
});
