import { expect, test } from "bun:test";
import { asText, scanText } from "./leak-gate.ts";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const GATE = join(import.meta.dir, "leak-gate.ts");
const run = (...args: string[]) => {
  const r = spawnSync("bun", [GATE, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const tmp = mkdtempSync(join(tmpdir(), "leak-gate-test-"));
const deny = join(tmp, "deny.txt");
writeFileSync(deny, "# comment\nzorblax\nquux-corp\nfirst-last\n");
// built at runtime so this file never carries a scanner-tripping literal
const secret = "ghp_" + "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4";

const fx = join(tmp, "fx");
mkdirSync(join(fx, "nested"), { recursive: true });
const files: Record<string, string | Buffer> = {
  "deny.md": "intro\nthe ZORBLAX service\n",
  "variants.txt": "zorblax_x\nzorblaxApp\nzorblax-12\nfirst_last\nquux%2Dcorp\nfirst.last\nowner first-\nlast\n",
  "ip.txt": "connect to 10.20.30.40 now\n",
  "ts.txt": "peer 100.101.102.103 up\n",
  "ts6.txt": "peer fd7a:115c:a1e0::1\n",
  "magic.txt": "host box.tail1234.ts.net\n",
  "email.txt": "mail ops@corp.io please\n",
  "home.txt": "see /home/bob/notes\n",
  "root.txt": "see /root/stuff\n",
  "nested/key.env": `GITHUB_TOKEN=${secret}\n`,
  "sameline.txt": `mail ops@corp.io key=${secret}\n`,
  "utf16.txt": Buffer.from("﻿hello", "utf16le"),
  "nul.txt": Buffer.from("ok\0zorblax"),
  "blob.gz": gzipSync("hello"),
  "badutf8.txt": Buffer.from([0x68, 0xc3, 0x28]),
};
for (const [f, c] of Object.entries(files)) writeFileSync(join(fx, f), c);
symlinkSync("/etc/hostname", join(fx, "link"));

const clean = join(tmp, "clean");
mkdirSync(clean);
writeFileSync(
  join(clean, "task.json"),
  JSON.stringify({
    title: "add strict types to parser",
    notes: "loopback 127.0.0.1, bind 0.0.0.0, docs 192.0.2.7 198.51.100.9 203.0.113.250, version 1.2.3.400",
    contact: "dev@example.com, qa@svc.test",
    path: "/tmp/work/src/a.ts, /rooted/x",
  }),
);

const rel = (out: string) => out.trim().split("\n").map((l) => l.replace(fx + "/", ""));

test("each rule fires on its fixture, as bare file:line:rule", () => {
  const r = run("--denylist", deny, fx);
  expect(r.code).toBe(1);
  expect(rel(r.out)).toEqual(
    expect.arrayContaining([
      "deny.md:2:deny",
      "ip.txt:1:ipv4",
      "ts.txt:1:tailscale-ip",
      "ts6.txt:1:tailscale-ip",
      "magic.txt:1:tailscale-host",
      "email.txt:1:email",
      "home.txt:1:home-path",
      "root.txt:1:home-path",
      expect.stringMatching(/^nested\/key\.env:1:gitleaks:/),
      expect.stringMatching(/^sameline\.txt:1:gitleaks:/),
      "sameline.txt:1:email",
    ]),
  );
});

test("denylist is substring: underscore/camel/suffix/snake/%-encoded/dotted/line-split all hit", () => {
  const got = rel(run("--denylist", deny, fx).out).filter((l) => l.startsWith("variants.txt:"));
  expect(got).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `variants.txt:${n}:deny`));
});

test("non-text and non-regular files are unscannable hits, never decoded", () => {
  const got = rel(run("--denylist", deny, fx).out);
  for (const f of ["utf16.txt", "nul.txt", "blob.gz", "badutf8.txt", "link"]) expect(got).toContain(`${f}:1:unscannable`);
  expect(asText(Buffer.from("﻿plain\ttext\r\n"))).not.toBeNull();
});

test("no line content is ever printed", () => {
  const r = run("--denylist", deny, fx);
  const all = r.out + r.err;
  for (const v of [secret, "10.20.30.40", "100.101.102.103", "ops@corp.io", "/home/bob", "zorblax", "ZORBLAX", "tail1234"])
    expect(all).not.toContain(v);
  for (const l of r.out.trim().split("\n")) expect(l).toMatch(/^\S+:\d+:[\w:-]+$/);
});

test("clean fixture passes (allowlisted IPs/emails)", () => {
  const r = run("--denylist", deny, clean);
  expect(r.err).toContain("0 hit(s)");
  expect(r.code).toBe(0);
});

test("missing or empty denylist fails closed with exit 2", () => {
  expect(run("--denylist", join(tmp, "nope.txt"), clean).code).toBe(2);
  const empty = join(tmp, "empty.txt");
  writeFileSync(empty, "# only comments\n\n");
  expect(run("--denylist", empty, clean).code).toBe(2);
});

test("read error fails closed with exit 2", () => {
  const d = join(tmp, "unreadable");
  mkdirSync(d);
  const f = join(d, "x.txt");
  writeFileSync(f, "hi\n");
  chmodSync(f, 0o000);
  expect(run("--denylist", deny, d).code).toBe(2);
  chmodSync(f, 0o644);
});

test("scanText dedupes per line+rule and maps split terms to their first line", () => {
  expect(scanText("f", "zorblax zorblax at 10.0.0.9\nzor\nblax", ["zorblax"])).toEqual([
    { file: "f", line: 1, rule: "deny" },
    { file: "f", line: 1, rule: "ipv4" },
    { file: "f", line: 2, rule: "deny" },
  ]);
});

// wb-201: deliberate obfuscation of a deny term must still hit. Terms are made up; never the real denylist.
const T = ["zorblax"];
const denyLines = (text: string) => scanText("f", text, T).filter((h) => h.rule === "deny").map((h) => h.line);
const b64 = (s: string) => Buffer.from(s).toString("base64");
const hex = (s: string) => Buffer.from(s).toString("hex");

test("deny: Cyrillic/Greek homoglyphs, fullwidth and accents fold to Latin", () => {
  expect(denyLines("ok\nzоrblаx\n")).toEqual([2]); // Cyrillic o, a
  expect(denyLines("ZΟRBLΑX")).toEqual([1]); // Greek capital Omicron, Alpha
  expect(denyLines("ｚｏｒｂｌａｘ")).toEqual([1]); // fullwidth
  expect(denyLines("zórbläx")).toEqual([1]); // combining marks
});

test("deny: HTML entities (decimal, hex, named) decode before match", () => {
  expect(denyLines("&#122;orbl&#x61;x")).toEqual([1]);
  expect(denyLines("&#X7A;&#111;rblax")).toEqual([1]);
  expect(denyLines("zor&amp;blax")).toEqual([1]);
});

test("deny: JSON \\uXXXX escapes decode before match", () => {
  expect(denyLines(JSON.stringify({ t: "x" }).replace("x", "\\u007aorbl\\u0061x"))).toEqual([1]);
});

test("deny: reversed text hits", () => {
  expect(denyLines("ok\nxalbroz svc")).toEqual([2]);
});

test("deny: base64 runs (std and url-safe) decode and hit", () => {
  expect(denyLines(`blob: "${b64("the zorblax svc")}"`)).toEqual([1]);
  expect(denyLines(`v="${b64("zorblax")}"`)).toEqual([1]); // 12 chars incl. padding
  expect(denyLines(`k=${b64("~~zorblax~~??>>").replace(/\+/g, "-").replace(/\//g, "_")}`)).toEqual([1]);
});

test("deny: hex runs decode and hit", () => {
  expect(denyLines(`h=${hex("zorblax")}`)).toEqual([1]); // 14 hex chars
  expect(denyLines(`h=0x${hex("my zorblax").toUpperCase()}`)).toEqual([1]);
});

test("deny: ordinary TS source with hashes and long identifiers stays clean", () => {
  const src = [
    'import { createHash } from "node:crypto";',
    "export const SHA = \"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\";",
    "const integrity = \"sha512-Q2xh1yJ0dW5kZXJzdGFuZGluZ0FsbFRoZUJhc2U2NA==\";",
    "function normalizeConfigurationValues(input: Record<string, unknown>) { return input; }",
    "const url = `https://example.com/api/v1/resources?id=${encodeURIComponent(id)}&amp;x=1`;",
    "const s = \"caf\\u00e9 \\u2014 na\\u00efve\";",
  ].join("\n");
  expect(denyLines(src)).toEqual([]);
  expect(denyLines(readFileSync(GATE, "utf8"))).toEqual([]);
});
