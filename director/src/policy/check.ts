// Write-lane gate — DESIGN.md invariant 7.
//
// ONE shared check function; every enforcement point routes through it:
//   - hooks/pre-write-lane.sh (worker-shell PreToolUse hook, §4.3 rung 2)
//   - merge-gate / diff-review path (CLI: `bun src/policy/check.ts <path>...`)
// There is deliberately no second allowlist anywhere else in the repo.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface LaneOpts {
  /** ledger db to consult for human-gate approvals; missing file = no approvals */
  db?: string;
  /** home override (tests); default os.homedir() */
  home?: string;
  /** true when the write is the ledger itself via bookie (invariant 2) */
  viaBookie?: boolean;
  /** directory relative targets resolve against; default process.cwd(). Only
   *  honoured when it is itself in-lane. */
  base?: string;
}

export type LaneVerdict = { ok: true } | { ok: false; reason: string };

// The five lane targets. The ledger is the fifth but bookie-only, so it is not
// a plain path prefix — see checkWritePath.
const ALLOW_PREFIXES = [
  "~/repos/**",
  // Workers are dispatched into ~/worktrees/<repo>-<task>/ and must be able to
  // write into the worktree they were assigned. DESIGN.md §4.3 states the default
  // lane as "repo+worktree paths only" (`["<repo>/**", "<worktree>/**"]`) — the
  // omission here blocked every worktree task needing to write an ADR/SPEC/CHOICES.
  "~/worktrees/**",
  "/tmp/**",
  "~/vault/ke/**",
  "~/vault/director/**",
  // ~/trash: the to-trash/retire destination (operator ruling arc-ypp, 2026-10-30).
  // Move-in only by rule (GLOBAL-RULES write lane); nothing there is read back as config or code.
  "~/trash/**",
];
export const ALLOWLIST_DISPLAY = [...ALLOW_PREFIXES, "ledger-via-bookie"];

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * `~otheruser/...` — a real shell expands this to that user's home, which is
 * out of lane. The gate does not know other users' homes, so it cannot resolve
 * it: fail-CLOSED, same as an unexpanded variable. (Plain `~`/`~/` is handled
 * by expandHome and stays allowed.)
 */
function hasForeignTilde(p: string): boolean {
  return p.startsWith("~") && p !== "~" && !p.startsWith("~/");
}

/**
 * A target still carrying shell syntax the gate cannot evaluate: a variable
 * (`$HOME`, `${FOO}`), a command substitution (`$(...)`, backticks), or a bare
 * `$` left behind when an extractor stopped at a brace. Any `$` or backtick at
 * all is unresolvable — matching only `$`+letter let `${HOME}/bin/a` through as
 * a plain relative path, which then resolved clean against the in-lane cwd.
 */
function hasUnexpandedVar(p: string): boolean {
  return /[$`]/.test(p);
}

/**
 * Absolute form of a target, or null when it cannot be resolved.
 *
 * Relative targets resolve against `base` — but only a caller that knows its own
 * base is in-lane may supply one. An unexpanded `$HOME`/`$VAR` is unresolvable at
 * any base (the gate sees the literal the shell never expanded), so it is always
 * null. Invariant 7 is fail-CLOSED: unresolvable means blocked, never "assume ok".
 */
function toAbs(target: string, home: string, base?: string): string | null {
  if (hasUnexpandedVar(target) || hasForeignTilde(target)) return null;
  const e = expandHome(target, home);
  if (isAbsolute(e)) return resolve(e);
  return base === undefined ? null : resolve(base, e);
}

/** Boundary-safe prefix match: /a/b matches /a/b and /a/b/c, not /a/bc. */
function underPrefix(abs: string, prefixAbs: string): boolean {
  const p = prefixAbs.endsWith("/") ? prefixAbs : prefixAbs + "/";
  return abs === prefixAbs || abs.startsWith(p);
}

/**
 * Fold `lane-approve <abs-prefix>` / `lane-revoke <abs-prefix>` tokens out of
 * human-gate note events, in seq order — later events win (revoke is how an
 * unlock expires). Returns the surviving approved prefixes.
 */
function approvedPrefixes(dbPath: string, home: string): string[] {
  if (!existsSync(dbPath)) return [];
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }
  const live = new Set<string>();
  try {
    const rows = db
      .query<{ p: string | null }, []>(
        "SELECT payload_md AS p FROM issue_events WHERE kind='note' AND (payload_md LIKE '%lane-approve%' OR payload_md LIKE '%lane-revoke%') ORDER BY seq",
      )
      .all();
    for (const r of rows) {
      if (!r.p) continue;
      for (const m of r.p.matchAll(/lane-(approve|revoke)\s+(\S+)/g)) {
        const prefix = resolve(expandHome(m[2], home));
        if (m[1] === "approve") live.add(prefix);
        else live.delete(prefix);
      }
    }
  } finally {
    db.close();
  }
  return [...live];
}

/** Allowlist prefix match, plus any live `lane-approve` human-gate unlock. */
function inLane(abs: string, home: string, opts: LaneOpts): boolean {
  for (const p of ALLOW_PREFIXES) {
    const prefixAbs = toAbs(p.replace(/\/\*+$/, ""), home);
    if (prefixAbs !== null && underPrefix(abs, prefixAbs)) return true;
  }
  if (opts.db) {
    for (const prefix of approvedPrefixes(opts.db, home)) {
      if (underPrefix(abs, prefix)) return true;
    }
  }
  return false;
}

export function checkWritePath(target: string, opts: LaneOpts = {}): LaneVerdict {
  const home = opts.home ?? homedir();

  // A relative target is only as trustworthy as the directory it resolves
  // against. A dispatched worker's cwd IS its worktree, so `> notes.txt` is
  // genuinely in-lane; but if cwd is out-of-lane, resolving against it would
  // manufacture an in-lane-looking path. So: resolve against cwd only when cwd
  // itself passes the lane check.
  const base = opts.base ?? process.cwd();
  const baseAbs = toAbs(base, home);
  const baseInLane = baseAbs !== null && inLane(baseAbs, home, opts);
  const abs = toAbs(target, home, baseInLane ? baseAbs : undefined);
  if (abs === null) {
    const why = hasUnexpandedVar(target)
      ? "it still carries unexpanded shell syntax ($ or backtick), which the gate cannot resolve"
      : hasForeignTilde(target)
      ? "it is a ~user path, whose home the gate cannot resolve"
      : `it is relative and the directory it would resolve against (${base}) is itself outside the lane`;
    return {
      ok: false,
      reason: `write-lane violation: ${target} cannot be resolved to an in-lane path — ${why}. ` + allowlistHint(),
    };
  }

  // The ledger (fifth lane target) is bookie-only — invariant 2. Protected:
  // the canonical ~/vault/ledger.db plus whatever db this check was told to
  // consult (--db / LEDGER_DB). Any other .db follows the plain allowlist.
  const consultedDb = opts.db ? resolve(expandHome(opts.db, home)) : undefined;
  if (abs === join(home, "vault", "ledger.db") || abs === consultedDb) {
    if (opts.viaBookie) return { ok: true };
    return {
      ok: false,
      reason: `write-lane violation: ${abs} is the ledger — writes are bookie-only (invariant 2). ` + allowlistHint(),
    };
  }

  if (inLane(abs, home, opts)) return { ok: true };

  return {
    ok: false,
    reason: `write-lane violation: ${abs} is outside the write-lane allowlist [${ALLOWLIST_DISPLAY.join(", ")}]. ` + allowlistHint(),
  };
}

function allowlistHint(): string {
  return 'Unlock requires a human-gate approval: ledger event kind=note, payload "lane-approve <prefix>".';
}

// --- CLI: the merge-gate / diff-review entry point.
// `bun src/policy/check.ts [--db <ledger>] [--base <dir>] <target>...`
//   → exit 0 all ok, 1 any rejected.
// Relative targets resolve against --base (default cwd), and only if that dir is
// itself in-lane: a merge-gate passing a `git diff --name-only` list runs
// `--base <repo-root>`.

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let db: string | undefined;
  let base: string | undefined;
  const targets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") db = argv[++i];
    else if (argv[i] === "--base") base = argv[++i];
    else targets.push(argv[i]);
  }
  if (targets.length === 0) {
    console.error("usage: bun src/policy/check.ts [--db <ledger>] [--base <dir>] <target>...");
    process.exit(2);
  }
  let failed = false;
  for (const t of targets) {
    const v = checkWritePath(t, { db, base });
    if (!v.ok) {
      console.error(`LANE_BLOCKED ${t}: ${v.reason}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}
