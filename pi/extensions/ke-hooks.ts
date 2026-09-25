/**
 * ke-hooks.ts — pi extension wiring user-prompt + session-end hooks into the
 * shared portable Knowledge Engine scripts.
 *
 * On every user input the extension fires
 *   ~/repos/ke/hooks/portable/post-prompt.sh
 * with the user's text as `user_message`, parses the returned {"context":...}
 * envelope, and injects it as a silent context message so the agent sees a
 * "[KE] background research started…" hint on the next LLM turn.
 *
 * On session shutdown the extension fires
 *   ~/repos/ke/hooks/portable/stop-update-nag.sh
 * with the recent conversation history, then prints the nag to stderr so the
 * operator sees suggested `ke add` topics before the session disappears.
 *
 * Both scripts are non-blocking by design (post-prompt detaches its child
 * research process), so the extension never delays user input or shutdown.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const KE_ROOT = process.env["KE_ROOT"] ?? join(process.env["HOME"] ?? "", "repos", "ke");
const POST_PROMPT = join(KE_ROOT, "hooks", "portable", "post-prompt.sh");
const STOP_NAG = join(KE_ROOT, "hooks", "portable", "stop-update-nag.sh");
const HOOK_TIMEOUT_MS = 15_000;

/** Run a shell-hook script with the given JSON payload on stdin.
 *  Returns parsed stdout JSON, or null on any failure (timeout, non-zero exit,
 *  invalid JSON). Failures are silent — KE hooks should never break pi. */
async function runHook(scriptPath: string, payload: object, timeoutMs = HOOK_TIMEOUT_MS): Promise<any | null> {
  if (!existsSync(scriptPath)) return null;
  return new Promise((resolve) => {
    const child = spawn(scriptPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const finish = (val: any | null) => { if (!settled) { settled = true; resolve(val); } };
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} finish(null); }, timeoutMs);
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.on("error", () => { clearTimeout(timer); finish(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) return finish(null);
      try { finish(JSON.parse(stdout)); } catch { finish(null); }
    });
    try { child.stdin.write(JSON.stringify(payload)); child.stdin.end(); } catch { finish(null); }
  });
}

/** Pull the last few user messages out of pi's session file so the stop hook
 *  can suggest concrete `ke add` topics. Best-effort — returns [] on any
 *  parsing failure. */
function readRecentUserMessages(sessionFile: string | undefined, max = 4): string[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  try {
    const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
    const messages: string[] = [];
    for (let i = lines.length - 1; i >= 0 && messages.length < max; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const text = entry?.message?.content ?? entry?.content ?? entry?.text;
        const role = entry?.message?.role ?? entry?.role;
        if (role === "user" && typeof text === "string" && text.length >= 40) {
          messages.unshift(text);
        }
      } catch { /* skip unparseable line */ }
    }
    return messages;
  } catch { return []; }
}

export default function (pi: ExtensionAPI) {
  // Fire on every user input. Non-blocking — research is spawned detached.
  pi.on("input", async (event, ctx) => {
    // event.source is "interactive" | "rpc" | "extension". Skip only
    // extension-triggered input to avoid feedback loops; honor both
    // interactive prompts and `pi -p` one-shot prompts (rpc).
    if (!event.text || event.source === "extension") return { action: "continue" };
    const session_id = process.env["PI_SESSION_ID"] ?? "";
    const out = await runHook(POST_PROMPT, { user_message: event.text, session_id });
    const context = out?.context;
    if (typeof context === "string" && context.length > 0) {
      try {
        ctx.sendMessage({
          customType: "ke-context",
          content: context,
          display: false,   // silent — agent sees it, terminal doesn't
        });
      } catch { /* extension API mismatch — ignore */ }
    }
    return { action: "continue" };
  });

  // Fire at session shutdown. There's no LLM turn left to inject into, so
  // print the nag to stderr — operator sees it before the session disappears.
  pi.on("session_shutdown", async (event) => {
    const session_id = process.env["PI_SESSION_ID"] ?? "";
    const session_file = process.env["PI_SESSION_FILE"] ?? "";
    const recent = readRecentUserMessages(session_file);
    const payload = {
      session_id,
      shutdown_reason: event.reason,
      conversation_history: recent.map((m) => ({ role: "user", content: m })),
    };
    const out = await runHook(STOP_NAG, payload, 10_000);
    const context = out?.context;
    if (typeof context === "string" && context.length > 0) {
      // Two newlines either side so it doesn't get swallowed by other shutdown noise.
      process.stderr.write(`\n\n${context}\n\n`);
    }
  });
}
