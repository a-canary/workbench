import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, loadConfig } from "./pane";

// Seats place: one row per seat file, a page per seat, and domain / mission / responsibilities edited
// in textareas. A save rewrites the seat file in its git repo and commits it, naming the field changed,
// so there is history and an undo. The fixture seats are made up; the real ones live in the config folder.

let dir: string;
const git = (...a: string[]) => {
  const p = Bun.spawnSync(["git", "-C", dir, ...a]);
  return p.stdout.toString().trim();
};
const seatFile = (n: string) => join(dir, `${n}.json`);
const alive = async (n: string) => n === "alpha";
const deps = () => ({ beadDirs: [], run: async () => ({ code: 0, out: "[]" }), seatsDir: dir, seatAlive: alive });
const get = (path: string) => handle(new Request(`http://pane.test${path}`), deps());
const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  handle(
    new Request(`http://pane.test${path}`, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers,
    }),
    deps()
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seats-"));
  git("init", "-q");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.test");
  writeFileSync(
    seatFile("alpha"),
    JSON.stringify({ seat: "alpha", kind: "lead", priority: 3, start: "run alpha", domain: "Widgets", mission: "Ship <b>widgets</b>" }) + "\n"
  );
  writeFileSync(seatFile("beta"), JSON.stringify({ seat: "beta", kind: "worker", model: "m1", lane: "private" }) + "\n");
  writeFileSync(join(dir, "alpha.json.pre-old"), "not a seat");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
});

test("loadConfig: seatsDir is optional and must be a string", () => {
  const c = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(c, "pane.json"), JSON.stringify({ beadDirs: [], seatsDir: "/s" }));
  expect(loadConfig(c).seatsDir).toBe("/s");
  writeFileSync(join(c, "pane.json"), JSON.stringify({ beadDirs: [], seatsDir: 5 }));
  expect(() => loadConfig(c)).toThrow(/seatsDir/);
});

test("GET /seats: one row per seat with domain, mission, state and a link; text is escaped", async () => {
  const res = await get("/seats");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('href="/seats/alpha"');
  expect(html).toContain('href="/seats/beta"');
  expect(html).not.toContain("pre-old");
  expect(html).toContain("Widgets");
  expect(html).toContain("Ship &lt;b&gt;widgets&lt;/b&gt;");
  expect(html).not.toContain("<b>widgets</b>");
  expect(html).toMatch(/alpha[\s\S]*running[\s\S]*beta[\s\S]*stopped/);
});

test("GET /seats without seatsDir says so instead of failing", async () => {
  const res = await handle(new Request("http://pane.test/seats"), { beadDirs: [], run: async () => ({ code: 0, out: "[]" }) });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("seatsDir");
});

test("GET /seats/:name: textareas for the three fields, read-only facts, 404 for unknown or odd names", async () => {
  const html = await (await get("/seats/beta")).text();
  for (const f of ["domain", "mission", "responsibilities"]) expect(html).toContain(`<textarea name="${f}"`);
  expect(html).toContain('action="/seats/beta/save"');
  expect(html).toContain("private");
  expect((await get("/seats/nope")).status).toBe(404);
  expect((await get("/seats/..%2Fx")).status).toBe(404);
  expect((await get("/seats/alpha.json.pre-old")).status).toBe(404);
});

test("POST save: writes the field, keeps the others, and commits naming the field changed", async () => {
  const res = await post("/seats/alpha/save", { domain: "Widgets", mission: "Ship widgets", responsibilities: "Keep CI green" });
  expect(res.status).toBe(303);
  const seat = JSON.parse(readFileSync(seatFile("alpha"), "utf8"));
  expect(seat).toMatchObject({ seat: "alpha", kind: "lead", priority: 3, start: "run alpha", domain: "Widgets", mission: "Ship widgets", responsibilities: "Keep CI green" });
  expect(git("log", "--format=%s", "-1")).toBe("seats: alpha: edit mission, responsibilities");
  expect(git("status", "--porcelain")).toBe("");
  // the commit has the file only, so an undo is one git revert
  expect(git("show", "--name-only", "--format=", "HEAD")).toBe("alpha.json");
});

test("POST save: nothing changed means no commit", async () => {
  const before = git("rev-parse", "HEAD");
  const res = await post("/seats/alpha/save", { domain: "Widgets", mission: "Ship <b>widgets</b>", responsibilities: "" });
  expect(res.status).toBe(303);
  expect(git("rev-parse", "HEAD")).toBe(before);
});

test("POST save: unrelated dirty files in the repo are not swept into the commit", async () => {
  writeFileSync(join(dir, "notes.txt"), "scratch");
  git("add", "notes.txt");
  await post("/seats/beta/save", { domain: "D", mission: "", responsibilities: "" });
  expect(git("show", "--name-only", "--format=", "HEAD")).toBe("beta.json");
  expect(git("status", "--porcelain")).toBe("A  notes.txt");
});

test("POST save: foreign origin, unknown seat, wrong method and oversize fields are refused", async () => {
  const before = git("rev-parse", "HEAD");
  expect((await post("/seats/alpha/save", { domain: "x" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await post("/seats/nope/save", { domain: "x" })).status).toBe(404);
  expect((await post("/seats/alpha/save", { domain: "x".repeat(5000) })).status).toBe(400);
  expect((await get("/seats/alpha/save")).status).toBe(405);
  expect(git("rev-parse", "HEAD")).toBe(before);
  expect(JSON.parse(readFileSync(seatFile("alpha"), "utf8")).domain).toBe("Widgets");
});

test("POST save: a failed commit puts the file back and answers 500", async () => {
  const before = readFileSync(seatFile("beta"), "utf8");
  // a global core.hooksPath would hide the hook, so point it at the repo's own
  git("config", "core.hooksPath", join(dir, ".git", "hooks"));
  writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const res = await post("/seats/beta/save", { domain: "D", mission: "", responsibilities: "" });
  expect(res.status).toBe(500);
  expect(readFileSync(seatFile("beta"), "utf8")).toBe(before);
});
