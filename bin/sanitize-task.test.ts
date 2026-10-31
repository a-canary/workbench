import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTask, sanitize, stripPaths, write, type Row, type Task } from "./sanitize-task.ts";

const tmp = mkdtempSync(join(tmpdir(), "sanitize-test-"));
const deny = join(tmp, "deny.txt");
writeFileSync(deny, "zorblax\n");
const row: Row = { id: "t-1", rule: "M3", note: "x" };
const deps = (task: unknown) => ({
  callModel: async () => `<think>plan</think>\n${JSON.stringify(task)}`,
  sandbox: false, // bwrap jail covered by worker-sandbox-test; keep this hermetic and fast
  leakArgs: ["--denylist", deny, "--allow-no-gitleaks"],
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

test("accepts: start fails, reference passes, leak-clean", async () => {
  const v = await sanitize(row, deps(good), "p");
  expect(v.reason).toContain("leak-gate clean");
  expect(v.accepted).toBe(true);
  expect(v.task?.tags).toContain("M3");
  const p = write(tmp, row, v);
  expect(JSON.parse(readFileSync(p, "utf8")).reference_solution["shelf.py"]).toContain("-> str");
});

test("rejects on leak and never writes the task text", async () => {
  const leaky = { ...good, description: "built for the Zorblax team" };
  const v = await sanitize(row, deps(leaky), "p");
  expect(v.accepted).toBe(false);
  expect(v.reason).toBe("leak-gate");
  expect(v.hits?.some((h) => h.includes("deny"))).toBe(true);
  const p = write(tmp, { ...row, id: "t-leak" }, v);
  expect(p).toContain("/rejected/");
  expect(readFileSync(p, "utf8").toLowerCase()).not.toContain("zorblax");
});

test("rejects when verify already passes on the start state", async () => {
  const trivial = { ...good, setup_files: { ...good.setup_files, ...good.reference_solution } };
  const v = await sanitize(row, deps(trivial), "p");
  expect(v.accepted).toBe(false);
  expect(v.reason).toBe("verify passes on start state");
});

test("rejects when the reference does not pass", async () => {
  const broken = { ...good, reference_solution: { "shelf.py": "def label(n):\n    return 'nope'\n" } };
  expect((await sanitize(row, deps(broken), "p")).reason).toContain("fails with reference");
});

test("rejects unsafe filenames and non-JSON output", async () => {
  expect((await sanitize(row, deps({ ...good, setup_files: { "../x.py": "" } }), "p")).reason).toContain("unsafe");
  const v = await sanitize(row, { ...deps(good), callModel: async () => "sorry" }, "p");
  expect(v.reason).toContain("no JSON");
  expect(existsSync(join(tmp, "..", "x.py"))).toBe(false);
});

test("extractTask skips fences/braces in strings; stripPaths drops paths and ips", () => {
  expect(extractTask('```json\n{"a":"}{","b":{"c":1}}\n```').b).toEqual({ c: 1 });
  const s = stripPaths("error in src/dashboards/x.ts(23,52) at ~/repos/foo/bar host 10.1.2.3");
  expect(s).not.toMatch(/dashboards|repos|10\.1\.2\.3/);
});
