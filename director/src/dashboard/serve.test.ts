// wb-an0.5 slice 3: the standalone driver dashboard server — loadCtx (bd context for the live sprint),
// GET /driver/ renders driverPanel + steer controls, POST /driver/steer applies one form via applySteer.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sprint } from "../sprint/log.ts";
import { handle, loadCtx, readLog, spawnRun, type Run, type Srv } from "./serve.ts";

const T0 = Date.parse("2026-10-29T20:00:00Z");
const cur = { dir: "/r/wb", id: "wb-7", project: "wb" } as Sprint;

// Canned bd/queue stdout keyed by the joined command; unknown commands fail ("").
const fake = (m: Record<string, string>): { run: Run; calls: string[] } => {
  const calls: string[] = [];
  return { calls, run: async (cmd) => (calls.push(cmd.join(" ")), m[cmd.join(" ")] ?? "") };
};
const QUEUE = ["bun", "q.ts", "6"];

describe("loadCtx", () => {
  test("deps from bd show, dependents from dep list --direction=up, last 3 comments, queue rows", async () => {
    const { run } = fake({
      "bd -C /r/wb show wb-7 --json": JSON.stringify([{ id: "wb-7", dependencies: [{ id: "wb-1", title: "base", status: "closed" }] }]),
      "bd -C /r/wb dep list wb-7 --direction=up --json": JSON.stringify([{ id: "wb-9", title: "after", status: "open" }]),
      "bd -C /r/wb comments wb-7 --json": JSON.stringify(
        ["a", "b", "c", "d"].map((t, i) => ({ author: "op", text: t, created_at: `2026-10-29T1${i}:00:00Z` })),
      ),
      "bun q.ts 6": "/r/wb\twb-8\tP1\tnext thing\n/r/x\tx-2\tP2\tother\n",
    });
    const c = await loadCtx(cur, run, QUEUE);
    expect(c.deps).toEqual([{ id: "wb-1", title: "base", status: "closed" }]);
    expect(c.dependents).toEqual([{ id: "wb-9", title: "after", status: "open" }]);
    expect(c.comments.map((x) => x.text)).toEqual(["b", "c", "d"]);
    expect(c.comments[0]).toEqual({ ts: "2026-10-29T11:00:00Z", author: "op", text: "b" });
    expect(c.queue).toEqual([{ id: "wb-8", title: "next thing" }, { id: "x-2", title: "other" }]);
    expect(c.missions).toEqual([]);
  });

  test("no live sprint: only the queue is fetched; failing or garbage output yields empty lists", async () => {
    const { run, calls } = fake({ "bun q.ts 6": "" });
    expect(await loadCtx(undefined, run, QUEUE)).toEqual({ deps: [], dependents: [], comments: [], missions: [], queue: [] });
    expect(calls).toEqual(["bun q.ts 6"]);
    const bad = fake({ "bd -C /r/wb show wb-7 --json": "not json", "bd -C /r/wb comments wb-7 --json": "{}" });
    const c = await loadCtx(cur, bad.run, QUEUE);
    expect(c.deps).toEqual([]);
    expect(c.comments).toEqual([]);
  });
});

describe("readLog", () => {
  test("parses JSONL, skipping blank and unparseable lines; missing file = []", () => {
    const d = mkdtempSync(join(tmpdir(), "serve-"));
    const p = join(d, "sprints.jsonl");
    writeFileSync(p, `{"ev":"start","id":"a"}\n\nnot json\n{"ev":"end","id":"a"}\n`);
    expect(readLog(p).map((e) => e.ev)).toEqual(["start", "end"]);
    expect(readLog(join(d, "nope.jsonl"))).toEqual([]);
  });
});

const srv = (): Srv & { dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), "serve-"));
  const log = join(dir, "sprints.jsonl");
  writeFileSync(
    log,
    JSON.stringify({ ev: "start", ts: new Date(T0).toISOString(), lane: "claude", dir: "/r/wb", project: "wb", id: "wb-7", title: "live <bead>", priority: 1, mem: [], ke: [], steer: [] }) + "\n",
  );
  return { dir, lane: "claude", log, steer: join(dir, "steer.json"), run: fake({}).run, queueCmd: QUEUE, now: () => T0 + 5 * 60_000 };
};
const post = (body: Record<string, string>) =>
  new Request("http://x/driver/steer", { method: "POST", body: new URLSearchParams(body) });

describe("handle", () => {
  test("GET /driver/ renders the live sprint, escaped, plus pin/skip/note forms posting to /driver/steer", async () => {
    const s = srv();
    const r = await handle(new Request("http://x/driver/"), s);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const h = await r.text();
    expect(h.startsWith("<!doctype html>")).toBe(true);
    expect(h).toContain("live &lt;bead&gt;");
    expect(h).not.toContain("live <bead>");
    expect(h).toContain('action="/driver/steer"');
    for (const a of ["pin", "skip", "note"]) expect(h).toContain(`name="action" value="${a}"`);
  });

  test("GET /driver/?flash= shows the flash escaped", async () => {
    const h = await (await handle(new Request("http://x/driver/?flash=%3Cb%3Ehi"), srv())).text();
    expect(h).toContain("&lt;b&gt;hi");
  });

  test("POST /driver/steer applies the form, writes the steer file, 303s back with flash ok", async () => {
    const s = srv();
    const r = await handle(post({ action: "pin", id: "wb-12" }), s);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/driver/?flash=ok");
    expect(JSON.parse(readFileSync(s.steer, "utf8"))).toEqual({ pin: ["wb-12"], skip: [], notes: [] });
    await handle(post({ action: "note", text: "look at 4.2" }), s);
    const st = JSON.parse(readFileSync(s.steer, "utf8"));
    expect(st.pin).toEqual(["wb-12"]);
    expect(st.notes.map((n: { text: string }) => n.text)).toEqual(["look at 4.2"]);
  });

  test("POST /driver/steer with a rejected form writes nothing and flashes the error", async () => {
    const s = srv();
    const r = await handle(post({ action: "pin", id: "../etc" }), s);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/driver/?flash=${encodeURIComponent("bad bead id")}`);
    expect(() => readFileSync(s.steer, "utf8")).toThrow();
  });

  test("other paths and methods are 404", async () => {
    const s = srv();
    expect((await handle(new Request("http://x/"), s)).status).toBe(404);
    expect((await handle(new Request("http://x/driver/steer"), s)).status).toBe(404);
    expect((await handle(new Request("http://x/driver/", { method: "POST" }), s)).status).toBe(404);
  });
});

test("spawnRun: stdout of a real process on exit 0; \"\" on non-zero exit or a missing binary", async () => {
  expect(await spawnRun(["sh", "-c", "sleep 0.05; echo hi"])).toBe("hi\n");
  expect(await spawnRun(["sh", "-c", "echo no; exit 1"])).toBe("");
  expect(await spawnRun(["/nonexistent-binary-xyz"])).toBe("");
});
