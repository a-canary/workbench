import { expect, test } from "bun:test";
import { scanText } from "./leak-gate.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = join(import.meta.dir, "leak-gate.ts");
const run = (...args: string[]) => {
  const r = spawnSync("bun", [GATE, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const tmp = mkdtempSync(join(tmpdir(), "leak-gate-test-"));
const deny = join(tmp, "deny.txt");
writeFileSync(deny, "# comment\nzorblax\nquux-corp\n");
// built at runtime so this file never carries a scanner-tripping literal
const secret = "ghp_" + "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4";

const fx = join(tmp, "fx");
mkdirSync(join(fx, "nested"), { recursive: true });
const files: Record<string, string> = {
  "deny.md": "intro\nthe ZORBLAX service\nzorblaxed is not a hit\n",
  "ip.txt": "connect to 10.20.30.40 now\n",
  "ts.txt": "peer 100.101.102.103 up\n",
  "email.txt": "mail ops@corp.io please\n",
  "home.txt": "see /home/bob/notes\n",
  "nested/key.env": `GITHUB_TOKEN=${secret}\n`,
};
for (const [f, c] of Object.entries(files)) writeFileSync(join(fx, f), c);

const clean = join(tmp, "clean");
mkdirSync(clean);
writeFileSync(
  join(clean, "task.json"),
  JSON.stringify({
    title: "add strict types to parser",
    notes: "loopback 127.0.0.1, bind 0.0.0.0, docs 192.0.2.7 198.51.100.9 203.0.113.250, version 1.2.3.400",
    contact: "dev@example.com, qa@svc.test, near-miss words zorblax-team and quux-corpse",
    path: "/tmp/work/src/a.ts",
  }),
);

test("each rule fires on its fixture, with file:line:rule", () => {
  const r = run("--denylist", deny, fx);
  expect(r.code).toBe(1);
  const got = r.out.trim().split("\n").map((l) => l.split("  ")[0].replace(fx + "/", ""));
  expect(got).toEqual(
    expect.arrayContaining([
      "deny.md:2:deny",
      "ip.txt:1:ipv4",
      "ts.txt:1:tailscale-ip",
      "email.txt:1:email",
      "home.txt:1:home-path",
      expect.stringMatching(/^nested\/key\.env:1:gitleaks:/),
    ]),
  );
  expect(got).not.toContain("deny.md:3:deny"); // whole-word only
});

test("matched values are never printed", () => {
  const r = run("--denylist", deny, fx);
  const all = r.out + r.err;
  for (const v of [secret, "10.20.30.40", "100.101.102.103", "ops@corp.io", "/home/bob"]) expect(all).not.toContain(v);
  expect(all).toContain("[REDACTED]");
});

test("clean fixture passes (allowlisted IPs/emails, near-miss words)", () => {
  // "zorblax-team" contains the term followed by '-': hyphen counts as a word char, so it is not the term
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

test("scanText redacts every match in the snippet", () => {
  const [h, ...rest] = scanText("f", "zorblax at 10.0.0.9 by a@b.io", ["zorblax"]);
  expect(h.snippet).toBe("[deny] at [ipv4] by [email]");
  expect(rest.map((x) => x.rule)).toEqual(["ipv4", "email"]);
});
