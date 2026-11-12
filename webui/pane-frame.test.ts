import { expect, test } from "bun:test";
import { applyDecision, handle, type Run } from "./pane";

// From merge review:
// (1) The pane has no login, so another site must not be able to show it inside a frame and trick a click
//     onto a verdict button. Every response says it may not be framed.
// (2) A failed label move leaves a verdict comment on a card that is still waiting. That is safe: the reader
//     only looks at cards labelled `decided` and takes the last verdict comment, so the first comment was
//     never acted on and a retry replaces it.
// (3) A command that cannot start during a write gives a plain 500, not an uncaught error.

const CARD = `<decide><q>Ship?</q><option id="A" rec="1" title="Ship now">Fast.</option><option id="B" title="Wait a day">Safer.</option></decide>`;
const card = { code: 0, out: JSON.stringify([{ id: "x-1", labels: ["human"], description: CARD }]) };
const MOVE = ["-C", "/a", "update", "x-1", "--add-label", "decided", "--remove-label", "human"];
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://pane:8081${path}`, { headers: { host: "pane:8081", ...headers } });
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request("http://pane:8081/inbox/decide", {
    method: "POST",
    headers: { host: "pane:8081", "sec-fetch-site": "same-origin", ...headers },
    body: new URLSearchParams(fields),
  });
const noFrame = (res: Response) => {
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
};

test("handle: every response refuses to be shown in a frame", async () => {
  const run: Run = async (a) => (a[2] === "show" ? card : { code: 0, out: "[]" });
  const deps = { beadDirs: ["/a"], run, hosts: ["pane:8081"] };
  const verdict = { dir: "/a", id: "x-1", action: "accept:A", text: "" };
  const cases: [Request, number][] = [
    [get("/inbox"), 200],
    [get("/feed"), 200],
    [get("/"), 302],
    [get("/nope"), 404],
    [get("/inbox/decide"), 405],
    [get("/inbox", { host: "evil.example:8081" }), 421],
    [post(verdict), 303],
    [post(verdict, { "sec-fetch-site": "cross-site" }), 403],
    [post({ ...verdict, action: "launch" }), 400],
  ];
  for (const [req, status] of cases) {
    const res = await handle(req, deps);
    expect(res.status).toBe(status);
    noFrame(res);
  }
});

test("applyDecision: after a failed label move, a retry writes the verdict again and then moves the labels", async () => {
  const calls: string[][] = [];
  let moves = 0;
  const run: Run = async (a) => {
    if (a[2] === "show") return card;
    calls.push(a);
    if (a[2] === "update") return { code: ++moves === 1 ? 1 : 0, out: "" };
    return { code: 0, out: "" };
  };
  const input = { dir: "/a", id: "x-1", action: "accept:A", text: "" };
  expect(await applyDecision(input, ["/a"], run)).toContain("update");
  expect(await applyDecision({ ...input, action: "accept:B" }, ["/a"], run)).toBeNull();
  expect(calls).toEqual([
    ["-C", "/a", "comments", "add", "--author", "operator", "--", "x-1", "DECISION accept A"],
    MOVE,
    ["-C", "/a", "comments", "add", "--author", "operator", "--", "x-1", "DECISION accept B"],
    MOVE,
  ]);
});

test("handle: a command that cannot start during a write gives a plain 500", async () => {
  const run: Run = async (a) => {
    if (a[2] === "show") return card;
    throw new Error("spawn failed: /secret/path");
  };
  const res = await handle(post({ dir: "/a", id: "x-1", action: "accept:A", text: "" }), { beadDirs: ["/a"], run });
  expect(res.status).toBe(500);
  expect(await res.text()).toBe("could not write the verdict; check the card before trying again");
  noFrame(res);
});
