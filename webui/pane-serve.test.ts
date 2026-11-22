import { expect, test } from "bun:test";
import { parsePort, allowedHosts, loadConfig } from "./pane";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// serve.ts start-up validation: config loading, port parsing, and host resolution
// must all succeed or fail with clear messages before the server binds.

test("serve start-up: valid config loads and port parses", () => {
  const dir = mkdtempSync(join(tmpdir(), "pane-serve-"));
  try {
    writeFileSync(join(dir, "pane.json"), JSON.stringify({ beadDirs: ["/a"] }));
    const cfg = loadConfig(dir);
    expect(cfg.beadDirs).toEqual(["/a"]);
    expect(parsePort("9000")).toBe(9000);
    expect(parsePort(undefined)).toBe(8081);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve start-up: bad config fails with a named path", () => {
  const dir = mkdtempSync(join(tmpdir(), "pane-serve-"));
  try {
    writeFileSync(join(dir, "pane.json"), "{ broken");
    expect(() => loadConfig(dir)).toThrow(join(dir, "pane.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve start-up: host resolution works for default and explicit hosts", () => {
  expect(allowedHosts({}, "127.0.0.1", 8081)).toEqual(["127.0.0.1:8081", "localhost:8081"]);
  expect(allowedHosts({ hosts: ["example.com:8081"] }, "127.0.0.1", 8081)).toEqual(["example.com:8081"]);
});

test("serve start-up: bad port fails with a clear message", () => {
  for (const bad of ["abc", "", "0", "70000"]) {
    expect(() => parsePort(bad)).toThrow("PORT");
  }
});
