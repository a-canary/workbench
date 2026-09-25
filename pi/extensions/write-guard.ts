/**
 * write-guard: enforce write policy
 *
 * Blocks edit/write unless target is:
 * - spec/test file (*.spec.*, *.test.*, *_test.*, test_*)
 * - in a git worktree (not main repo root)
 * - in /tmp or ~/tmp
 * - in an agents-pub test plan
 *
 * Reads always allowed.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SPEC_PATTERNS = [
  /\.spec\.(ts|js|tsx|jsx|go|py|rs|c|cpp|h)$/,
  /\.test\.(ts|js|tsx|jsx|go|py|rs|c|cpp|h)$/,
  /_test\.(go|py|rs|c|cpp|h)$/,
  /^test_.*\.(py|rs|c|cpp|h|sh)$/,
];

function isSpecFile(path: string): boolean {
  return SPEC_PATTERNS.some(p => p.test(path));
}

function isInWorktree(path: string): boolean {
  // Check if path is under a worktree directory
  // Heuristic: contains "/worktrees/" or "/worktree-"
  return /\/worktrees?\//.test(path) || /\/worktree-/.test(path);
}

function isTmp(path: string): boolean {
  return path.startsWith("/tmp/") || path.startsWith("~/tmp/");
}

function isAgentsPubPlan(path: string): boolean {
  return path.includes("/agents-pub/plans/");
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.tool !== "edit" && event.tool !== "write") return;

    const target = event.args?.path ?? event.args?.file ?? "";
    if (!target) return;

    if (isSpecFile(target) || isInWorktree(target) || isTmp(target) || isAgentsPubPlan(target)) {
      return; // allow
    }

    // Block
    if (ctx.hasUI) {
      ctx.ui.notify(
        `✋ Write blocked: ${target}\nNot a spec file, worktree, /tmp, or agents-pub plan.\nCreate a worktree first.`,
        "error"
      );
    }
    event.cancelled = true;
  });
}
