// Mandatory merge gates — DESIGN.md §4.6.
//
// All merges must pass three non-waivable gates:
//   1. worktree-isolation — changes originate from ~/worktrees/, not main checkout
//   2. ponytail-review — complexity review; >3 findings = reject
//   3. hard-merge — independent adversarial review (DefendMerge)
//
// Usage:
//   import { checkMergeGates } from "./merge-gates";
//   const verdict = checkMergeGates({ diffSource, ponytailFindings, hardMergeReport });
//   if (!verdict.ok) { /* reject merge */ }

export interface MergeGateInput {
  /** The path from which the diff originated */
  diffSource: string;
  /** Number of ponytail-review findings (complexity items) */
  ponytailFindings?: number;
  /** Path to the hard-merge (DefendMerge) report */
  hardMergeReport?: string;
  /** Home directory override (for testing) */
  home?: string;
}

export interface MergeGateVerdict {
  ok: boolean;
  failedGates: string[];
  reasons: string[];
}

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const MAX_PONYTAIL_FINDINGS = 3;

/**
 * Check all mandatory merge gates.
 * Returns {ok: true} if all pass, or {ok: false, failedGates, reasons}.
 */
export function checkMergeGates(input: MergeGateInput): MergeGateVerdict {
  const home = input.home ?? homedir();
  const failedGates: string[] = [];
  const reasons: string[] = [];

  // Gate 1: worktree-isolation
  const worktreePrefix = resolve(home, "worktrees");
  const src = resolve(input.diffSource);
  if (!src.startsWith(worktreePrefix)) {
    failedGates.push("worktree-isolation");
    reasons.push(
      `diff originates from ${input.diffSource}, not under ~/worktrees/ — changes must be made in a worktree, not the main checkout`,
    );
  }

  // Gate 2: ponytail-review (complexity)
  const findings = input.ponytailFindings ?? -1;
  if (findings === -1) {
    failedGates.push("ponytail-review");
    reasons.push("ponytail-review not run — must run ponytail-review on diff before merge");
  } else if (findings > MAX_PONYTAIL_FINDINGS) {
    failedGates.push("ponytail-review");
    reasons.push(
      `ponytail-review found ${findings} complexity items (max ${MAX_PONYTAIL_FINDINGS}) — simplify before merging`,
    );
  }

  // Gate 3: hard-merge (independent review)
  if (!input.hardMergeReport) {
    failedGates.push("hard-merge");
    reasons.push("no hard-merge (DefendMerge) report provided — independent adversarial review required");
  } else if (!existsSync(input.hardMergeReport)) {
    failedGates.push("hard-merge");
    reasons.push(`hard-merge report file not found: ${input.hardMergeReport}`);
  }

  return {
    ok: failedGates.length === 0,
    failedGates,
    reasons,
  };
}

// CLI: bun src/policy/merge-gates.ts --source <path> [--ponytail N] [--hardmerge <report>]
if (import.meta.main) {
  const argv = process.argv.slice(2);
  let source = "";
  let ponytail: number | undefined;
  let hardmerge: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source") source = argv[++i];
    else if (argv[i] === "--ponytail") ponytail = parseInt(argv[++i], 10);
    else if (argv[i] === "--hardmerge") hardmerge = argv[++i];
  }
  if (!source) {
    console.error("usage: bun src/policy/merge-gates.ts --source <path> [--ponytail N] [--hardmerge <report>]");
    process.exit(2);
  }
  const v = checkMergeGates({ diffSource: source, ponytailFindings: ponytail, hardMergeReport: hardmerge });
  if (!v.ok) {
    console.error("MERGE_BLOCKED: failed gates: " + v.failedGates.join(", "));
    for (const r of v.reasons) console.error("  - " + r);
    process.exit(1);
  }
  console.log("MERGE_OK: all mandatory gates passed");
  process.exit(0);
}
