// TDD for the write-lane gate (DESIGN.md invariant 7).
// One shared check function; every caller (PreToolUse hook, merge-gate CLI) routes through it.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { checkWritePath, ALLOWLIST_DISPLAY } from "./check";

// home is a pure string the check resolves against — it must NOT exist under
// /tmp, or every "out-of-lane" path would fall in the real /tmp lane.
let home: string;
let sandbox: string; // real dir for temp ledger db files (in-lane /tmp)

beforeEach(() => {
  home = `/home/lane-check-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sandbox = mkdtempSync(join(tmpdir(), "lane-check-"));
});

afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

function ledgerWith(events: string[]): string {
  const dbPath = join(sandbox, "test-ledger.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE issue_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id TEXT NOT NULL,
    ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    agent TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_md TEXT
  )`);
  const ins = db.query("INSERT INTO issue_events (issue_id, agent, kind, payload_md) VALUES (?,?,?,?)");
  for (const p of events) ins.run("lane-gate-test", "captain", "note", p);
  db.close();
  return dbPath;
}

// --- acceptance 1: out-of-lane rejected, error names the allowlist ---

test("rejects ~/bin write and names the full allowlist in the reason", () => {
  const v = checkWritePath("~/bin/x", { home });
  expect(v.ok).toBe(false);
  if (!v.ok) {
    for (const entry of ALLOWLIST_DISPLAY) expect(v.reason).toContain(entry);
  }
});

test("rejects ~/scratch write", () => {
  expect(checkWritePath("~/scratch/x", { home }).ok).toBe(false);
});

test("rejects other vault subtrees (vault/notes is not vault/ke or vault/director)", () => {
  expect(checkWritePath("~/vault/notes/x.md", { home }).ok).toBe(false);
});

// --- acceptance 2: all allowed targets pass unimpeded ---

test("allows ~/repos/**", () => {
  expect(checkWritePath("~/repos/arc-director/src/a.ts", { home }).ok).toBe(true);
});

test("allows /tmp/**", () => {
  expect(checkWritePath("/tmp/whatever/deep/file", { home }).ok).toBe(true);
});

test("allows ~/vault/ke/**", () => {
  expect(checkWritePath("~/vault/ke/arc-director/note.md", { home }).ok).toBe(true);
});

test("allows ~/vault/director/**", () => {
  expect(checkWritePath("~/vault/director/memory.md", { home }).ok).toBe(true);
});

test("allows ~/trash/** (arc-ypp) but not a sibling prefix", () => {
  expect(checkWritePath("~/trash/1793400000_foo-20261031/reason.md", { home }).ok).toBe(true);
  expect(checkWritePath("~/trash", { home }).ok).toBe(true); // `mv x ~/trash`
  expect(checkWritePath("~/trashy/x", { home }).ok).toBe(false);
  expect(checkWritePath("~/trash/../.bashrc", { home }).ok).toBe(false);
});

// A worker is dispatched into ~/worktrees/<repo>-<task>/ and must be able to write
// docs (ADR, SPEC, CHOICES) into its own assigned worktree. DESIGN.md §4.3 states
// the default lane as "repo+worktree paths only" (`["<repo>/**", "<worktree>/**"]`);
// omitting it blocked every worktree task that needed to write a file.
test("allows ~/worktrees/**", () => {
  expect(checkWritePath("~/worktrees/arc-agents-some-task/docs/adr/0002-x.md", { home }).ok).toBe(true);
});

test("ledger db passes only via bookie (invariant 2)", () => {
  const ledger = join(home, "vault", "ledger.db"); // string check only; no fs needed
  expect(checkWritePath(ledger, { home, viaBookie: true }).ok).toBe(true);
  const direct = checkWritePath(ledger, { home });
  expect(direct.ok).toBe(false);
  if (!direct.ok) expect(direct.reason).toMatch(/bookie/i);
});

test("a non-ledger .db in an allowed lane (~/vault/director) passes without viaBookie", () => {
  expect(checkWritePath(join(home, "vault", "director", "scratch.db"), { home }).ok).toBe(true);
});

// --- acceptance 3: human-gate approval event unlocks a path; without it, still rejected ---

test("human-gate lane-approve event unlocks the approved prefix", () => {
  const db = ledgerWith([`lane-approve ${join(home, "scratch")}`]);
  expect(checkWritePath("~/scratch/x", { home, db }).ok).toBe(true);
});

test("no approval event: out-of-lane path still rejected even with a db present", () => {
  const db = ledgerWith(["some unrelated note"]);
  const v = checkWritePath("~/scratch/x", { home, db });
  expect(v.ok).toBe(false);
});

test("approval is prefix-boundary safe: approving ~/bin does not unlock ~/binary", () => {
  const db = ledgerWith([`lane-approve ${join(home, "bin")}`]);
  expect(checkWritePath("~/bin/x", { home, db }).ok).toBe(true);
  expect(checkWritePath("~/binary/x", { home, db }).ok).toBe(false);
});

test("approval for an exact file path unlocks only that file", () => {
  const target = join(home, "agents", "one.md");
  const db = ledgerWith([`lane-approve ${target}`]);
  expect(checkWritePath(target, { home, db }).ok).toBe(true);
  expect(checkWritePath(join(home, "agents", "two.md"), { home, db }).ok).toBe(false);
});

test("lane-revoke expires a prior lane-approve (seq order, later wins)", () => {
  const prefix = join(home, "scratch");
  const db = ledgerWith([`lane-approve ${prefix}`, `lane-revoke ${prefix}`]);
  expect(checkWritePath("~/scratch/x", { home, db }).ok).toBe(false);
});

test("a re-approve after revoke unlocks again", () => {
  const prefix = join(home, "scratch");
  const db = ledgerWith([`lane-revoke ${prefix}`, `lane-approve ${prefix}`]);
  expect(checkWritePath("~/scratch/x", { home, db }).ok).toBe(true);
});

test("the consulted --db ledger itself is bookie-only even outside ~/vault", () => {
  const db = ledgerWith([]); // temp db under /tmp lane — still bookie-only as consulted ledger
  expect(checkWritePath(db, { home, db }).ok).toBe(false);
  expect(checkWritePath(db, { home, db, viaBookie: true }).ok).toBe(true);
});

// --- fail-closed: a target the gate cannot resolve is not in-lane ---
// cwd is the in-lane worktree, so resolving these against it would pass an
// out-of-lane write (invariant 7 is fail-CLOSED, not fail-open).

test("rejects a target carrying an unexpanded shell variable", () => {
  const v = checkWritePath("$HOME/bin/x", { home, base: "/tmp/worker" });
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain("unexpanded shell syntax");
});

test("an unexpanded variable is not unlockable by a lane-approve either", () => {
  const db = ledgerWith([`lane-approve ${home}/bin`]);
  expect(checkWritePath("$HOME/bin/x", { home, db, base: "/tmp/worker" }).ok).toBe(false);
});

test("a relative target resolves against an in-lane base and is allowed", () => {
  // a dispatched worker's cwd IS its worktree — `> notes.txt` is genuinely in-lane
  expect(checkWritePath("notes.txt", { home, base: "/tmp/worker" }).ok).toBe(true);
});

test("a relative target escaping an in-lane base is still rejected", () => {
  // ../../.. climbs above /tmp entirely, so the resolved path is out of lane
  const v = checkWritePath("../../../etc/passwd", { home, base: "/tmp/worker/sub" });
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain("outside the write-lane allowlist");
});

test("a relative target is rejected when the base itself is out of lane", () => {
  const v = checkWritePath("notes.txt", { home, base: `${home}/bin` });
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain("outside the lane");
});

test("brace and command-substitution forms are unresolvable too", () => {
  const H = "$" + "{HOME}";
  const sub = "$" + "(echo x)";
  const tick = "`" + "echo x" + "`";
  for (const t of [`${H}/bin/x`, `${sub}/bin/x`, `${tick}/bin/x`]) {
    const v = checkWritePath(t, { home, base: "/tmp/worker" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("unexpanded shell syntax");
  }
});

test("a ~user path is unresolvable (another user's home is not ours to guess)", () => {
  const v = checkWritePath("~someuser/bin/x", { home, base: "/tmp/worker" });
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain("~user path");
});

// --- acceptance 4: one shared function — hook + CLI import this module ---
// Structural: hooks/pre-write-lane.sh shells out to `bun src/policy/check.ts`;
// there is no second allowlist implementation anywhere in the repo.
test("no duplicate allowlist literals outside check.ts", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(
    "grep", ["-rln", "vault/director", "--include=*.sh", "--include=*.json", "."],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" },
  );
  // .claude/settings.json must not restate the allowlist; neither may any hook script.
  expect(r.stdout.trim()).toBe("");
});
