// Hook-level tests: PreToolUse JSON in → exit code out.
// Uses the real $HOME (paths are only checked, never written) and a temp
// ledger db so no live lane-approve events can leak into the results.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
// invariant 7: ONE allowlist. Assert against the source of truth, not a copy of it.
import { ALLOWLIST_DISPLAY } from "../src/policy/check.ts";

const HOOK = join(import.meta.dirname, "pre-write-lane.sh");
let sandbox: string;
let emptyDb: string;
let approvedDb: string;
// must be outside every lane (not /tmp, not under $HOME) — string only, never created
const approvedPrefix = `/opt/lane-hook-approved-${Date.now()}`;

function runHook(payload: object, db: string): { code: number; stderr: string } {
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, LEDGER_DB: db },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stderr: r.stderr };
}

function makeDb(path: string, events: string[]): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE issue_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id TEXT NOT NULL, ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    agent TEXT NOT NULL, kind TEXT NOT NULL, payload_md TEXT)`);
  const ins = db.query("INSERT INTO issue_events (issue_id, agent, kind, payload_md) VALUES (?,?,?,?)");
  for (const p of events) ins.run("lane-gate-test", "captain", "note", p);
  db.close();
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "lane-hook-"));
  emptyDb = join(sandbox, "empty.db");
  approvedDb = join(sandbox, "approved.db");
  makeDb(emptyDb, []);
  makeDb(approvedDb, [`lane-approve ${approvedPrefix}`]);
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

// fail-closed: the shell never expands the payload the hook sees, so a target
// still carrying $HOME is unresolvable at any base and must be blocked.

test("Write to an unexpanded $HOME/bin target is blocked", () => {
  const r = runHook({ tool_name: "Write", tool_input: { file_path: "$HOME/bin/lane-hook-test-x" } }, emptyDb);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("unexpanded shell syntax");
});

test("Bash redirect to an unexpanded $HOME/bin target is blocked", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: 'echo x > "$HOME/bin/lane-hook-test-a"' } }, emptyDb);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("unexpanded shell syntax");
});

test("Bash tee to an unexpanded $HOME/bin target is blocked", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: 'echo x | tee "$HOME/bin/lane-hook-test-a"' } }, emptyDb);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("unexpanded shell syntax");
});

test("clobber and explicit-fd redirect forms are gated too", () => {
  for (const command of ["echo x >| /opt/lane-hook-clobber", "echo x 1> /opt/lane-hook-fd"]) {
    const r = runHook({ tool_name: "Bash", tool_input: { command } }, emptyDb);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("outside the write-lane allowlist");
  }
});

// A relative target is in-lane exactly when the cwd it resolves against is.
// The hook runs with cwd = the worktree, so ordinary relative writes must pass.
test("Bash redirect to a relative in-lane target is allowed", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "echo x > lane-hook-test-note.txt" } }, emptyDb);
  expect(r.code).toBe(0);
});

test("a relative target climbing out of the lane is blocked", () => {
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "echo x > ../../../../../../etc/lane-hook-test-a" } },
    emptyDb,
  );
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("outside the write-lane allowlist");
});

// Shell syntax the gate cannot evaluate must fail CLOSED at the hook too.
// Each of these once extracted a bare `$` (or nothing) and resolved clean
// against the in-lane cwd — the ticket's own bug class, one brace away.
test("brace, command-substitution and backtick targets are blocked", () => {
  const H = "$" + "{HOME}";
  const sub = "$" + "(echo $" + "HOME)";
  const tick = "`" + "echo ~" + "`";
  for (const t of [`${H}/bin/a`, `${sub}/bin/a`, `${tick}/bin/a`]) {
    const r = runHook({ tool_name: "Bash", tool_input: { command: `echo x > "${t}"` } }, emptyDb);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unexpanded shell syntax");
  }
});

test("a ~user path is blocked (the gate cannot resolve another user's home)", () => {
  const r = runHook({ tool_name: "Write", tool_input: { file_path: "~someuser/bin/x" } }, emptyDb);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("~user path");
});

// same quote-blindness bug class as the redirect and tee extractors
test("quoted of= and -o destinations are extracted and gated", () => {
  const cmds = [
    'dd if=/dev/zero bs=1k count=1 of="/opt/lane-hook-of"',
    'curl -s http://example.invalid -o "/opt/lane-hook-out"',
  ];
  for (const command of cmds) {
    const r = runHook({ tool_name: "Bash", tool_input: { command } }, emptyDb);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("outside the write-lane allowlist");
  }
});

// acceptance 1: out-of-lane write rejected, error names the allowlist
test("Write to ~/bin is blocked with the allowlist in stderr", () => {
  const r = runHook({ tool_name: "Write", tool_input: { file_path: `${process.env.HOME}/bin/lane-hook-test-x` } }, emptyDb);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("outside the write-lane allowlist");
  for (const entry of ALLOWLIST_DISPLAY) {
    expect(r.stderr).toContain(entry);
  }
});

test("Edit to ~/scratch is blocked", () => {
  const r = runHook({ tool_name: "Edit", tool_input: { file_path: `${process.env.HOME}/scratch/lane-hook-test-x` } }, emptyDb);
  expect(r.code).toBe(2);
});

// acceptance 2: allowed targets pass unimpeded
test("Write to /tmp passes", () => {
  const r = runHook({ tool_name: "Write", tool_input: { file_path: "/tmp/lane-hook-test-x" } }, emptyDb);
  expect(r.code).toBe(0);
});

test("Write to ~/repos/** passes", () => {
  const r = runHook({ tool_name: "Write", tool_input: { file_path: `${process.env.HOME}/repos/arc-director/lane-hook-test-x.ts` } }, emptyDb);
  expect(r.code).toBe(0);
});

test("Bash with no write targets passes", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "ls -la && git status" } }, emptyDb);
  expect(r.code).toBe(0);
});

test("non-write tools pass untouched", () => {
  const r = runHook({ tool_name: "Read", tool_input: { file_path: `${process.env.HOME}/bin/whatever` } }, emptyDb);
  expect(r.code).toBe(0);
});

// bash redirections are write targets too
test("Bash redirect to ~/scratch is blocked", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "echo hi > ~/scratch/lane-hook-test-x" } }, emptyDb);
  expect(r.code).toBe(2);
});

test("Bash fd dup (2>&1) is not a false positive", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "some-cmd 2>&1 | grep x" } }, emptyDb);
  expect(r.code).toBe(0);
});

test("Bash cp to ~/bin is blocked (write-verb destination)", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: `cp /tmp/tool ${process.env.HOME}/bin/lane-hook-test-x` } }, emptyDb);
  expect(r.code).toBe(2);
});

// repos-ged1: the extractor gated only the LAST arg of cp/mv/ln/rsync.
test("cp/mv -t and --target-directory= destinations are gated", () => {
  const bin = `${process.env.HOME}/bin`;
  for (const command of [
    `cp -t ${bin} /tmp/tool`,
    `mv -t ${bin} /tmp/a /tmp/b`,
    `cp --target-directory=${bin} /tmp/tool`,
    `cp --target-directory ${bin} /tmp/tool`,
  ]) {
    expect({ command, code: runHook({ tool_name: "Bash", tool_input: { command } }, emptyDb).code }).toEqual({ command, code: 2 });
  }
});

test("a quoted write-verb destination is gated", () => {
  const command = `mv /tmp/a "${process.env.HOME}/bin/lane-hook-test-x"`;
  expect(runHook({ tool_name: "Bash", tool_input: { command } }, emptyDb).code).toBe(2);
});

test("a trailing stderr redirect does not mask the write-verb destination", () => {
  const command = `mv /tmp/a ${process.env.HOME}/bin/lane-hook-test-x 2>/tmp/err.log`;
  expect(runHook({ tool_name: "Bash", tool_input: { command } }, emptyDb).code).toBe(2);
});

test("cp -t into an in-lane dir passes", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "cp -t /tmp/d /tmp/a /tmp/b" } }, emptyDb);
  expect(r.code).toBe(0);
});

test("Bash mv within /tmp passes", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "mv /tmp/a.txt /tmp/b.txt" } }, emptyDb);
  expect(r.code).toBe(0);
});

test("Bash dd of= to ~/scratch is blocked", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: `dd if=/dev/zero bs=1k count=1 of=${process.env.HOME}/scratch/lane-hook-test-x` } }, emptyDb);
  expect(r.code).toBe(2);
});

test("Bash read-only commands with -o (grep) are not false positives", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: `grep -oE 'x' ${process.env.HOME}/repos/arc-director/DESIGN.md` } }, emptyDb);
  expect(r.code).toBe(0);
});

// acceptance 3: human-gate approval event unlocks the path; without it, blocked
test("approved prefix passes with the approval db", () => {
  const r = runHook({ tool_name: "Write", tool_input: { file_path: `${approvedPrefix}/x.txt` } }, approvedDb);
  expect(r.code).toBe(0);
});

test("same path blocked without the approval event", () => {
  const r = runHook({ tool_name: "Write", tool_input: { file_path: `${approvedPrefix}/x.txt` } }, emptyDb);
  expect(r.code).toBe(2);
});

test("Bash redirect to the null device is not a write target", () => {
  const nul = "/" + "dev" + "/" + "null";
  const r = runHook({ tool_name: "Bash", tool_input: { command: `git -c core.hooksPath=${nul} status >${nul}` } }, emptyDb);
  expect(r.code).toBe(0);
});

test("Bash redirect to ~/bin is still blocked", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: `echo x > ${process.env.HOME}/bin/lane-hook-test-x` } }, emptyDb);
  expect(r.code).toBe(2);
});

// /dev/fd/N resolves through /proc/self/fd to a real file (and /dev/fd/N/name
// traverses into an opened directory) — it must stay blocked, not exempted.
test("Bash redirect to an fd-backed device path is still blocked", () => {
  const fd = "/" + "dev" + "/" + "fd" + "/3";
  const r = runHook({ tool_name: "Bash", tool_input: { command: `echo x > ${fd}` } }, emptyDb);
  expect(r.code).toBe(2);
});

test("Bash redirect to the stderr device is still blocked", () => {
  const se = "/" + "dev" + "/" + "stderr";
  const r = runHook({ tool_name: "Bash", tool_input: { command: `echo x > ${se}` } }, emptyDb);
  expect(r.code).toBe(2);
});

// Trailing whitespace once made the last-arg extractor return nothing (fail-open).
test("mv with trailing whitespace still gates its destination", () => {
  for (const tail of [" ", "\t"]) {
    const cmd = "mv a.json " + "~" + "/bin/" + tail;
    const r = runHook({ tool_name: "Bash", tool_input: { command: cmd } }, emptyDb);
    expect(r.code).toBe(2);
  }
});
