import { expect, test, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failuresHtml, handle, loadConfig, readFailures, type Run } from "./pane";

// Control pane, repos-27xl: the Feed shows current system failures above what landed. The pane only reads
// a text file (one failure per line) that a no-model host script rewrites; the web server runs no command.

const dir = mkdtempSync(join(tmpdir(), "pane-fail-"));
const paneRun: Run = async () => ({ code: 0, out: "[]" });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("failuresHtml: nothing to show is an empty string", () => {
  expect(failuresHtml([])).toBe("");
});

test("failuresHtml: heading with the count, one escaped line each", () => {
  const h = failuresHtml(["unit: foo.service failed", "stall: <b>ndv</b>"]);
  expect(h).toContain("<h2>Failures 2</h2>");
  expect(h.match(/class="feed-fail"/g)?.length).toBe(2);
  expect(h).toContain("unit: foo.service failed");
  expect(h).toContain("&lt;b&gt;ndv&lt;/b&gt;");
  expect(h).not.toContain("<b>ndv");
});

test("readFailures: missing file or no path reads as no failures", () => {
  expect(readFailures(undefined)).toEqual([]);
  expect(readFailures(join(dir, "absent.txt"))).toEqual([]);
});

test("readFailures: trims, drops blank lines, caps at 50 lines of 200 characters", () => {
  const f = join(dir, "f.txt");
  writeFileSync(f, "  unit: a failed  \n\n\r\nstall: b\n" + "x".repeat(500) + "\n");
  expect(readFailures(f)).toEqual(["unit: a failed", "stall: b", "x".repeat(200)]);
  writeFileSync(f, Array.from({ length: 80 }, (_, i) => `l${i}`).join("\n"));
  const r = readFailures(f);
  expect(r.length).toBe(50);
  expect(r[49]).toBe("l49");
});

test("readFailures: a directory or an oversized file never throws", () => {
  expect(readFailures(dir)).toEqual(["failures file unreadable"]);
  const big = join(dir, "big.txt");
  writeFileSync(big, "y".repeat(2 * 1024 * 1024));
  expect(readFailures(big)).toEqual(["failures file unreadable"]);
});

test("loadConfig: failuresFile is optional and must be a string", () => {
  const d1 = mkdtempSync(join(tmpdir(), "pane-cfg-"));
  try {
    writeFileSync(join(d1, "pane.json"), JSON.stringify({ beadDirs: ["/a"], failuresFile: "/x/f.txt" }));
    expect(loadConfig(d1).failuresFile).toBe("/x/f.txt");
    writeFileSync(join(d1, "pane.json"), JSON.stringify({ beadDirs: ["/a"] }));
    expect(loadConfig(d1).failuresFile).toBeUndefined();
    writeFileSync(join(d1, "pane.json"), JSON.stringify({ beadDirs: ["/a"], failuresFile: 7 }));
    expect(() => loadConfig(d1)).toThrow("failuresFile must be a string");
  } finally {
    rmSync(d1, { recursive: true, force: true });
  }
});

test("GET /feed shows the failures above the landed list; none configured shows none", async () => {
  const f = join(dir, "live.txt");
  writeFileSync(f, "user-unit: lane-front.service failed\n");
  const body = await (await handle(new Request("http://pane.test/feed"), { beadDirs: ["/a"], run: paneRun, failuresFile: f })).text();
  expect(body).toContain("<h2>Failures 1</h2>");
  expect(body).toContain("user-unit: lane-front.service failed");
  // in the page body, right above the landed list (not in <head>, where a browser would drop or misplace it)
  expect(body).toContain('</div><div class="feed-links">');
  expect(body.indexOf("</head>")).toBeLessThan(body.indexOf("Failures 1"));
  expect(body.indexOf("Failures 1")).toBeLessThan(body.indexOf('<div class="feed-links">'));
  const none = await (await handle(new Request("http://pane.test/feed"), { beadDirs: ["/a"], run: paneRun })).text();
  expect(none).not.toContain("<h2>Failures");
});
