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
  expect(run('/home/worker/.local/bin/pi -p x')).toBe(2);
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

// PR #67 review: bypasses of the first-word check (all must block)
test("blocks agent runs behind wrappers, nested shells and substitutions", () => {
  for (const c of [
    "timeout 600 claude -p x", "exec claude -p x", "command claude -p x", "sudo claude -p x", "nice -n 5 pi -p x",
    "stdbuf -o0 claude -p x", "xargs claude -p", "ls | xargs -I{} pi -p {}", 'bash -c "claude -p x"', "sh -lc 'a; claude -p x'",
    "eval claude -p x", "x=$(claude -p x)", 'echo "$(pi -p x)"', "echo `claude -p x`", "( claude -p x )", "{ claude -p x; }",
    "claude -pq x", 'FOO="a b" claude -p x', "cd x&&claude -p x", "ls\nclaude -p x",
    'claude --allowedTools "" --allowedTools Bash -p x', "claude -p 'x --allowedTools \"\" y'",
    'claude -p --allowedTools "" --dangerously-skip-permissions x', 'claude -p --allowedTools "" --mcp-config m.json x',
    'claude -p "unbalanced',
    // round 2: '#' truncation, shell -c behind wrappers, parens inside $(...), --agents
    "echo a#b; claude -p hi", 'sudo bash -c "claude -p x"', "timeout 5 bash -c 'claude -p x'", "env FOO=1 sh -c 'pi -p x'",
    "nohup bash -c 'claude -p x' &", "xargs -I{} sh -c 'claude -p {}'", 'echo "$(claude -p "(x)")"',
    'claude -p --allowedTools "" --agents a.json x',
    'sudo -u pi bash -c "claude -p hi"', "env -u pi bash -c 'claude -p x'",
  ]) expect([c, run(c)]).toEqual([c, 2]);
});

test("quoted text mentioning claude -p is data, not a run", () => {
  for (const c of [
    'echo "a | claude -p foo"', 'git commit -m "x; claude -p y"', 'echo "use claude -p; pi -p ok"', "echo claude -p",
    "git log --author claude -p", "claude --version", "pi --help",
    "git commit -m 'use `claude -p` here'", "echo 'x $(claude -p y)'", "FOO=1 grep pi -p file",
  ]) expect([c, run(c)]).toEqual([c, 0]);
  expect(run('claude -p --allowedTools= "q"')).toBe(0);
});
