import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTask, rowError, sanitize, stripPaths, type Row, type Task } from "./sanitize-task.ts";

// verify runs in the real bwrap jail (bin/worker-sandbox), which has python3; there is no unsandboxed mode to test
const tmp = mkdtempSync(join(tmpdir(), "sanitize-test-"));
const out = join(tmp, "synth");
const deny = join(tmp, "deny.txt");
writeFileSync(deny, "zorblax\n");
const row = (id: string): Row => ({ id, rule: "M3", note: "x" });
const deps = (task: unknown, extra: object = {}) => ({
  callModel: async () => `<think>plan</think>\n${JSON.stringify(task)}`,
  leakArgs: ["--denylist", deny, "--allow-no-gitleaks"],
  ...extra,
});
// strict gate stand-in that needs no extra tooling: tests pass on both, the "checker" greps for an annotation
const good: Task = {
  name: "toy-shelf-label",
  description: "d",
  instruction: "make tests and check pass",
  setup_files: { "shelf.py": "def label(n):\n    return f'bin {n}'\n", "t.py": "from shelf import label\nassert label(3) == 'bin 3'\n" },
  reference_solution: { "shelf.py": "def label(n: int) -> str:\n    return f'bin {n}'\n" },
  verify: "cd $BENCH_WORK_DIR && python3 t.py && grep -q -- '-> str' shelf.py",
};
const leftovers = () => readdirSync(out).filter((f) => f.includes(".tmp."));

test("accepts: start fails, reference passes, final object leak-gated and renamed into place", async () => {
  const v = await sanitize(row("t-acc"), deps(good), "p", out);
  expect(v.reason).toContain("leak-gate clean");
  expect(v.accepted).toBe(true);
  const saved = JSON.parse(readFileSync(join(out, "t-acc.json"), "utf8"));
  expect(saved.tags).toContain("M3");
  expect(saved.source).toBe("worker-failure-sanitizer");
  expect(saved.reference_solution["shelf.py"]).toContain("-> str");
  expect(leftovers()).toEqual([]);
});

test("rejects on leak with hit locations only; nothing lands in synth/", async () => {
  const v = await sanitize(row("t-leak"), deps({ ...good, description: "built for the Zorblax team" }), "p", out);
  expect(v.accepted).toBe(false);
  expect(v.reason).toBe("leak-gate");
  expect(v.hits?.some((h) => h.startsWith("t-leak.json:") && h.endsWith(":deny"))).toBe(true);
  expect(existsSync(join(out, "t-leak.json"))).toBe(false);
  expect(readFileSync(join(out, "rejected", "t-leak.json"), "utf8").toLowerCase()).not.toContain("zorblax");
  expect(leftovers()).toEqual([]);
});

test("rejects when verify already passes on the start state", async () => {
  const trivial = { ...good, setup_files: { ...good.setup_files, ...good.reference_solution } };
  const v = await sanitize(row("t-triv"), deps(trivial), "p", out);
  expect(v.reason).toBe("verify passes on start state");
  expect(existsSync(join(out, "t-triv.json"))).toBe(false);
});

test("a broken sandbox rejects: start 'fails' but the reference cannot pass in the same sandbox", async () => {
  const broken = join(tmp, "broken-sandbox");
  writeFileSync(broken, "#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n");
  chmodSync(broken, 0o755);
  const v = await sanitize(row("t-sbx"), deps(good, { sandboxBin: broken }), "p", out);
  expect(v.accepted).toBe(false);
  expect(v.reason).toContain("fails with reference");
});

test("rejects bad rows, unsafe filenames and non-JSON output", async () => {
  expect(rowError({ id: "../x", rule: "M3", note: "" })).toContain("id");
  expect(rowError({ id: "aw3-01h.3", rule: "M3", note: "" })).toBeNull();
  expect(rowError({ id: "aw3-pfo", rule: "m3; rm", note: "" })).toContain("rule");
  expect((await sanitize({ id: "a/b", rule: "M3", note: "" }, deps(good), "p", out)).accepted).toBe(false);
  expect((await sanitize(row("t-unsafe"), deps({ ...good, setup_files: { "../x.py": "" } }), "p", out)).reason).toContain("unsafe");
  expect((await sanitize(row("t-json"), { ...deps(good), callModel: async () => "sorry" }, "p", out)).reason).toContain("no JSON");
});

test("extractTask skips fences/braces in strings; stripPaths drops paths and ips", () => {
  expect(extractTask('```json\n{"a":"}{","b":{"c":1}}\n```').b).toEqual({ c: 1 });
  const s = stripPaths("error in src/dashboards/x.ts(23,52) at ~/repos/foo/bar host 10.1.2.3");
  expect(s).not.toMatch(/dashboards|repos|10\.1\.2\.3/);
});
