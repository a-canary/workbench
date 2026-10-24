#!/usr/bin/env bun
// notify — estate-wide alerting CLI.
//
//   notify <title> <body> [--severity error|warn|info] [--target discord|chat|both] [--source S]
//
// Fans out to Discord webhook (DISCORD_WEBHOOK_URL) and director chat
// (arc-chat post). NEVER throws on transport failure; stderr logs and exit
// code reflects whether AT LEAST ONE transport succeeded.
//
// Exit codes:
//   0  — at least one transport sent
//   1  — usage error (missing args)
//   2  — every configured transport failed or was skipped
//
// Replaces ledger feedback inserts across:
//   - trading/bin/trade-alert
//   - trading/bin/trade-rebalance-watchdog  
//   - trading/tools/{metrics,collect,targets}-watchdog.ts
//   - arc-agents/bin/{report-error.sh, auto-oversight-watchdog.sh}
//   - arc-skills/bin/health-monitor.ts
//   - llm-hosting/e103-watch.sh
//   - ndivisible deploy/health-monitor.sh + deploy-drift-check.sh
import { notify } from "../src/notify/notify";

const args = process.argv.slice(2);
const title = args[0];
const body = args[1];
if (!title || !body) {
  console.error("Usage: notify <title> <body> [--severity S] [--target T] [--source S]");
  process.exit(1);
}

const opts: Parameters<typeof notify>[0] = { title, body };
for (let i = 2; i < args.length; i++) {
  const a = args[i];
  const next = args[i + 1];
  if (a === "--severity" && next) { opts.severity = next as "error" | "warn" | "info"; i++; }
  else if (a === "--target" && next) { opts.target = next as "discord" | "chat" | "both"; i++; }
  else if (a === "--source" && next) { opts.source = next; i++; }
  else if (a === "--dedupe-key" && next) { opts.dedupeKey = next; i++; }
  else if (a === "--state" && next) { opts.state = next; i++; }
}

const res = await notify(opts);
if (res.discord === "sent" || res.chat === "sent") process.exit(0);
console.error(`notify: all transports failed (discord=${res.discord}, chat=${res.chat})`);
process.exit(2);
