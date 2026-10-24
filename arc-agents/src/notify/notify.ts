/**
 * notify — estate-wide alerting library.
 *
 * Sends to Discord webhook (DISCORD_WEBHOOK_URL env var) and/or director chat
 * (arc-chat post). Fan-out: both transports tried independently; neither blocks
 * the other. Never throws; errors are logged and reported in the result.
 *
 * Built-in dedupe: pass a `dedupeKey` to only alert on state transitions.
 * State lives in ~/vault/health/notify-state/ (one JSON file per dedupeKey).
 * This replaces the ledger feedback table that watchdogs used for spam-prevention.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join as pathJoin } from "node:path";

export interface NotifyOptions {
  title: string;
  body: string;
  severity?: "error" | "warn" | "info";
  target?: "discord" | "chat" | "both";
  source?: string;
  /** Dedupe key: only alert when `state` differs from the last notified state for this key. */
  dedupeKey?: string;
  /** Current state string for dedupe (e.g. "down"/"up"). Required when dedupeKey is set. */
  state?: string;
}

export interface NotifyResult {
  discord: "sent" | "skipped" | "failed";
  chat: "sent" | "skipped" | "failed";
}

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const NOTIFY_TARGET = process.env.NOTIFY_TARGET ?? "both";
const ARC_CHAT_BIN = process.env.ARC_CHAT_BIN ?? pathJoin(process.env.HOME ?? "", "repos", "arc-agents", "bin", "arc-chat.ts");

function join(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}

export function colorFor(severity?: string): number {
  switch (severity) {
    case "error": return 16711680;   // red
    case "warn":  return 16776960;   // yellow
    case "info":  return 65280;      // green
    default:      return 7500;        // gray
  }
}

/**
 * Send Discord webhook notification. Returns "sent", "skipped", or "failed".
 */
export async function notifyDiscord(opts: NotifyOptions): Promise<"sent" | "skipped" | "failed"> {
  const url = DISCORD_WEBHOOK_URL;
  if (!url) {
    console.error("notify: DISCORD_WEBHOOK_URL not set, skipping Discord");
    return "skipped";
  }
  const truncated = opts.body.slice(0, 1024);
  const payload = {
    username: opts.source ? `arc-${opts.source}` : "arc-alert",
    embeds: [{
      title: opts.title,
      description: truncated,
      color: colorFor(opts.severity),
      timestamp: new Date().toISOString(),
      footer: opts.severity ? { text: opts.severity.toUpperCase() } : undefined,
    }],
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`notify: Discord webhook returned ${res.status}`);
      return "failed";
    }
    return "sent";
  } catch (e) {
    console.error(`notify: Discord webhook failed: ${(e as Error).message}`);
    return "failed";
  }
}

/**
 * Send director chat notification via arc-chat CLI. Returns "sent", "skipped", or "failed".
 */
export async function notifyChat(opts: NotifyOptions): Promise<"sent" | "skipped" | "failed"> {
  // Use arc-chat post to send to director
  const chatBin = ARC_CHAT_BIN;
  const { spawnSync } = await import("node:child_process");

  // Build the message: include severity prefix and source
  const prefix = opts.severity ? `[${opts.severity.toUpperCase()}] ` : "";
  const src = opts.source ? ` (${opts.source})` : "";
  const msg = `${prefix}${opts.title}: ${opts.body.slice(0, 500)}${src}`;

  try {
    const r = spawnSync(process.execPath, [chatBin, "post", msg], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (r.status !== 0) {
      console.error(`notify: arc-chat post failed: ${r.stderr}`);
      return "failed";
    }
    return "sent";
  } catch (e) {
    console.error(`notify: arc-chat post error: ${(e as Error).message}`);
    return "failed";
  }
}

/** Dedupe state directory. */
const STATE_DIR = pathJoin(process.env.HOME ?? "", "vault", "health", "notify-state");

/** Read dedupe state for a key. Returns null if never notified. */
function readState(key: string): string | null {
  try {
    const path = pathJoin(STATE_DIR, `${key}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")).lastState ?? null;
  } catch { return null; }
}

/** Mark that we've notified for a key with a given state. */
function markNotified(key: string, state: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const path = pathJoin(STATE_DIR, `${key}.json`);
    writeFileSync(path, JSON.stringify({ lastState: state, at: new Date().toISOString() }, null, 2));
  } catch { /* ignore disk errors */ }
}

/**
 * Fan out to configured transports. Target "both" tries Discord then chat.
 * If `dedupeKey` is provided, only sends on state transitions (e.g. "up"→"down").
 * Returns aggregated result.
 */
export async function notify(opts: NotifyOptions): Promise<NotifyResult> {
  const target = opts.target ?? NOTIFY_TARGET;
  const results: NotifyResult = { discord: "skipped", chat: "skipped" };

  // Dedupe: if key provided and state unchanged, skip entirely. A dedupeKey
  // without a state is a caller bug (silently never deduping); shout about it.
  if (opts.dedupeKey) {
    if (!opts.state) {
      console.error(`notify: dedupeKey "${opts.dedupeKey}" set without state — treating every send as a transition`);
    } else {
      const priorState = readState(opts.dedupeKey);
      if (priorState === opts.state) {
        console.error(`notify: dedupe key "${opts.dedupeKey}" unchanged (${opts.state}), skipping`);
        return results;
      }
    }
    if (target === "discord" || target === "both") {
      results.discord = await notifyDiscord(opts);
    }
    if (target === "chat" || target === "both") {
      results.chat = await notifyChat(opts);
    }
    if (opts.state && (results.discord === "sent" || results.chat === "sent")) {
      markNotified(opts.dedupeKey, opts.state);
    }
    return results;
  }

  // No dedupe key: always send
  if (target === "discord" || target === "both") {
    results.discord = await notifyDiscord(opts);
  }
  if (target === "chat" || target === "both") {
    results.chat = await notifyChat(opts);
  }

  return results;
}
