import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedHosts, handle, loadConfig, parsePort, type Run } from "./pane";

// The pane has no login. A web page on another site can point its own name at the pane's address
// (DNS rebinding) and then looks same-origin to the browser. Refusing any request whose Host header
// is not one of the pane's own names closes that door, for reads and for verdict writes.

const run: Run = async () => ({ code: 0, out: "[]" });
const req = (path: string, host: string | null, init: RequestInit = {}) => {
  const r = new Request(`http://placeholder${path}`, init);
  if (host === null) r.headers.delete("host");
  else r.headers.set("host", host);
  return r;
};

test("handle: a request for a name the pane does not own is refused before anything runs", async () => {
  let calls = 0;
  const counting: Run = async (a) => {
    calls++;
    return run(a);
  };
  const deps = { beadDirs: ["/w1"], run: counting, hosts: ["pane.example:8081", "127.0.0.1:8081"] };
  for (const path of ["/inbox", "/feed", "/healthz", "/"]) {
    const res = await handle(req(path, "evil.example:8081"), deps);
    expect(res.status).toBe(421);
  }
  expect((await handle(req("/inbox", null), deps)).status).toBe(421);
  const post = await handle(
    req("/inbox/decide", "evil.example:8081", {
      method: "POST",
      headers: { origin: "http://evil.example:8081", "content-type": "application/x-www-form-urlencoded" },
      body: "dir=/w1&id=a-1&action=accept&text=",
    }),
    deps
  );
  expect(post.status).toBe(421);
  expect(calls).toBe(0);
});

test("handle: the pane's own names pass, compared without case; no list means no check", async () => {
  const deps = { beadDirs: ["/w1"], run, hosts: ["pane.example:8081"] };
  expect((await handle(req("/inbox", "pane.example:8081"), deps)).status).toBe(200);
  expect((await handle(req("/inbox", "PANE.Example:8081"), deps)).status).toBe(200);
  expect((await handle(req("/inbox", "anything:1"), { beadDirs: ["/w1"], run })).status).toBe(200);
});

test("allowedHosts: the configured list wins; otherwise the bound address plus this machine's local names", () => {
  expect(allowedHosts({ hosts: ["Pane.Example:8081"] }, "10.0.0.5", 8081)).toEqual(["pane.example:8081"]);
  expect(allowedHosts({}, "10.0.0.5", 8081)).toEqual(["10.0.0.5:8081", "localhost:8081", "127.0.0.1:8081"]);
  expect(allowedHosts({}, "127.0.0.1", 9000)).toEqual(["127.0.0.1:9000", "localhost:9000"]);
});

test("loadConfig: hosts is optional, and must be an array of strings when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "pane-"));
  const path = join(dir, "pane.json");
  writeFileSync(path, JSON.stringify({ beadDirs: ["/w1"], hosts: ["pane.example:8081"] }));
  expect(loadConfig(dir).hosts).toEqual(["pane.example:8081"]);
  writeFileSync(path, JSON.stringify({ beadDirs: ["/w1"] }));
  expect(loadConfig(dir).hosts).toBeUndefined();
  writeFileSync(path, JSON.stringify({ beadDirs: ["/w1"], hosts: "pane.example:8081" }));
  expect(() => loadConfig(dir)).toThrow(path);
  writeFileSync(path, JSON.stringify({ beadDirs: ["/w1"], hosts: [1] }));
  expect(() => loadConfig(dir)).toThrow(path);
});

test("parsePort: default 8081; anything that is not a whole port number is an error", () => {
  expect(parsePort(undefined)).toBe(8081);
  expect(parsePort("9000")).toBe(9000);
  for (const bad of ["abc", "", "0", "70000", "80.5", "-1"]) expect(() => parsePort(bad)).toThrow("PORT");
});
