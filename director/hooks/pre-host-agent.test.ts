// director-oot option 3: a PreToolUse hook that rejects host-side agent runs (`claude -p`, `pi -p`)
// outside worker-sandbox. A tool-less one-turn `claude -p --allowedTools ""` (ask-claude) stays
// allowed: it can't touch the filesystem, network or secrets.

import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const HOOK = join(import.meta.dirname, "pre-host-agent.sh");

function run(command: string, tool = "Bash"): number {
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    encoding: "utf8",
  });
  return r.status ?? -1;
}

test("blocks host claude -p with tools", () => {
  expect(run('claude -p "fix the bug"')).toBe(2);
  expect(run("cd /x && claude -p --model sonnet 'go'")).toBe(2);
  expect(run('claude --print "fix"')).toBe(2);
});

test("blocks host pi -p, including nohup/background/pipes", () => {
  expect(run('pi -p "do task"')).toBe(2);
  expect(run('nohup pi -p "task" > log 2>&1 &')).toBe(2);
  expect(run('cat task.md | pi -p')).toBe(2);
  expect(run('/home/aaron/.local/bin/pi -p x')).toBe(2);
});

test("allows tool-less one-turn claude -p (ask-claude)", () => {
  expect(run('cat r.md | claude -p --model opus --max-turns 1 --allowedTools "" "attack this"')).toBe(0);
  expect(run("claude -p --allowedTools '' 'q'")).toBe(0);
});

test("allows runs through worker-sandbox / worker-task / lane-run", () => {
  expect(run("worker-sandbox --worktree w --lane private --task t.md")).toBe(0);
  expect(run("bin/worker-task --repo r --id x")).toBe(0);
  expect(run("workbench/bin/lane-run --repo r --idle 600")).toBe(0);
});

test("ignores unrelated commands and non-Bash tools", () => {
  expect(run("git log -1")).toBe(0);
  expect(run("grep -n 'pi -p' notes.md")).toBe(0);
  expect(run("echo claude -p", "Read")).toBe(0);
  expect(run("bun test pipeline.test.ts")).toBe(0);
});
