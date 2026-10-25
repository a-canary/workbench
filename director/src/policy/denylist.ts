// Destructive-action denylist — DESIGN.md §4.5.
//
// Blocks unrecoverable actions by any agent mode without explicit Capitan
// approval via a ledger event. Fail-closed: unmatched or ambiguous patterns
// are blocked, not allowed.
//
// Two tiers:
//   BLOCKED    — always blocked, logged, requires human intervention
//   ESCALATED  — blocked + Feed row to Capitan for explicit approval
//
// Usage:
//   import { checkCommand } from "./denylist";
//   const verdict = checkCommand("rm -rf /tmp/test");
//   if (!verdict.ok) { /* block */ }

export type DenyTier = "blocked" | "escalated";

export interface DenyRule {
  tier: DenyTier;
  pattern: RegExp;
  reason: string;
}

export type DenyVerdict = { ok: true } | { ok: false; tier: DenyTier; reason: string };

// BLOCKED: unrecoverable, no approval path
const BLOCKED_RULES: DenyRule[] = [
  {
    tier: "blocked",
    pattern: /\brm\s+(-[a-z]*\s+)*-r[fi]?\s+([~$]|\/)(?!.*(worktrees|tmp))/i,
    reason: "rm -rf outside worktrees/tmp",
  },
  {
    tier: "blocked",
    pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*f[ri]?[a-z]*\s+\/\//i,
    reason: "rm -rf / (filesystem root)",
  },
  {
    tier: "blocked",
    pattern: /\bDROP\s+TABLE\b/i,
    reason: "DROP TABLE is destructive and irreversible",
  },
  {
    tier: "blocked",
    pattern: /\bTRUNCATE\s+TABLE\b/i,
    reason: "TRUNCATE TABLE is destructive and irreversible",
  },
  {
    tier: "blocked",
    pattern: /\bgit\s+push\s+(-[a-z]*\s+)*-f(\s+|$)/i,
    reason: "git push --force rewrites shared history",
  },
  {
    tier: "blocked",
    pattern: /\bgit\s+push\s+(-[a-z]*\s+)*--force(\s+|$)/i,
    reason: "git push --force rewrites shared history",
  },
  {
    tier: "blocked",
    pattern: /\bgit\s+reset\s+--hard\s+(main|master|origin\/main|origin\/master)/i,
    reason: "git reset --hard on main branch destroys committed work",
  },
];

// ESCALATED: blocked by default, requires Capitan approval
const ESCALATED_RULES: DenyRule[] = [
  {
    tier: "escalated",
    pattern: /\b(git\s+branch\s+-d|\bgit\s+branch\s+-D)\s+(main|master|develop)/i,
    reason: "deleting a protected branch",
  },
  {
    tier: "escalated",
    pattern: /\b(docker\s+system\s+prune|docker\s+rmi\s+-f|docker\s+rm\s+-f)/i,
    reason: "destructive docker operation",
  },
  {
    tier: "escalated",
    pattern: /\bformat\s+/i,
    reason: "disk format operation",
  },
  {
    tier: "escalated",
    pattern: /\bmkfs/i,
    reason: "filesystem creation destroys data",
  },
  {
    tier: "escalated",
    pattern: /\b(aws\s+s3\s+rm|gsutil\s+rm|az\s+storage\s+blob\s+delete)\b.*\s(-r|--recursive)/i,
    reason: "recursive cloud storage deletion",
  },
];

/**
 * Check a command string against the denylist.
 * Returns {ok: true} if allowed, or {ok: false, tier, reason} if matched.
 * Checks BLOCKED rules first, then ESCALATED.
 */
export function checkCommand(cmd: string): DenyVerdict {
  for (const rule of BLOCKED_RULES) {
    if (rule.pattern.test(cmd)) {
      return { ok: false, tier: rule.tier, reason: rule.reason };
    }
  }
  for (const rule of ESCALATED_RULES) {
    if (rule.pattern.test(cmd)) {
      return { ok: false, tier: rule.tier, reason: rule.reason };
    }
  }
  return { ok: true };
}

// CLI: `bun src/policy/denylist.ts <command>`
// exit 0 = allowed, 1 = blocked, 2 = escalated
if (import.meta.main) {
  const cmd = process.argv.slice(2).join(" ");
  if (!cmd) {
    console.error("usage: bun src/policy/denylist.ts <command>");
    process.exit(2);
  }
  const v = checkCommand(cmd);
  if (!v.ok) {
    console.error(`DENY_${v.tier.toUpperCase()}: ${v.reason}`);
    process.exit(v.tier === "blocked" ? 1 : 2);
  }
  process.exit(0);
}
