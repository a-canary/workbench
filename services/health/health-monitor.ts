#!/usr/bin/env bun
// health-monitor — one cron tick that probes the estate's long-running
// surfaces, reports a DOWN/UP *transition* to Discord, and keeps per-service
// state in the ledger's `feedback` table (the only message bus here).
//
// Design (why this shape):
//   - Drain-don't-spam: state lives in a feedback row `hm-<service>` whose
//     state='OPEN' means "currently down". A failure that inserts the row is
//     the only thing that alerts; a sustained outage re-inserts nothing. A
//     recovery flips the row to 'resolved' and alerts once. So the row IS the
//     dedupe key — no separate seen-state file to drift.
//   - One failing check never hides the others: every check is independent and
//     runs under its own timeout.
//   - Exit 0 always, even on outages. The cron ERR trap (cron-preamble) files a
//     report-error per failed tick; an outage is not a broken monitor.
//
// Cron (every 5 min; PATH pinned — bare `bun` is not in cron's PATH):
//   */5 * * * * PATH=/home/aaron/.bun/bin:/usr/local/bin:/usr/bin:/bin $HOME/.bun/bin/bun $HOME/repos/arc-agents/bin/health-monitor.ts >> $HOME/.cache/arc-health-monitor.log 2>&1
//
// Manual:  bun bin/health-monitor.ts [--quiet] [--dry-run]
//   --dry-run  probe + print, write no row/alert/file.
//
// Env: LEDGER_DB, VAULT_DIR, HEALTH_DIR, DISCORD_BOT_TOKEN,
//      HEALTH_DISCORD_CHANNEL (id), DISCORD_ALERT_CHANNEL_NAME (default
//      agent-events), DISCORD_WEBHOOK_URL (fallback transport).

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME ?? "";
const VAULT = process.env.VAULT_DIR ?? join(HOME, "vault");
const DB_PATH = process.env.LEDGER_DB ?? join(VAULT, "ledger.db");
const OUT_DIR = process.env.HEALTH_DIR ?? join(VAULT, "health");
const TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS ?? 4000);

export type Service = { id: string; project: string; probe: () => Promise<string> };

const fail = (msg: string): never => {
  throw new Error(msg);
};

// ---- native probe helpers -------------------------------------------------

async function get(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
}

/** First URL that answers 200 wins; throws with every attempt listed. */
async function firstOk(urls: string[]): Promise<string> {
  const tried: string[] = [];
  for (const u of urls) {
    const r = await get(u);
    if (r?.status === 200) return u;
    tried.push(`${u} → ${r ? r.status : "unreachable"}`);
  }
  return fail(`no healthy endpoint: ${tried.join(", ")}`);
}

function sh(cmd: string, args: string[]): { rc: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { rc: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Newest mtime (epoch ms) among `dirs`' files matching `re`, 0 if none. */
function newestLog(dirs: string[], re: RegExp): number {
  let newest = 0;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!re.test(f)) continue;
      const { mtimeMs } = statSync(join(d, f));
      if (mtimeMs > newest) newest = mtimeMs;
    }
  }
  return newest;
}

// ---- discord transport ----------------------------------------------------

let channelCache: string | undefined;

/** Alert channel id: explicit env, else the first guild channel whose name
 * matches DISCORD_ALERT_CHANNEL_NAME. Resolved from the bot token, so no
 * channel id is baked into this repo. */
async function alertChannel(token: string): Promise<string> {
  if (process.env.HEALTH_DISCORD_CHANNEL) return process.env.HEALTH_DISCORD_CHANNEL;
  if (channelCache) return channelCache;
  const name = process.env.DISCORD_ALERT_CHANNEL_NAME ?? "agent-events";
  const auth = { headers: { Authorization: `Bot ${token}` } };
  const guilds = (await (await get("https://discord.com/api/v10/users/@me/guilds", auth))?.json()) as
    | { id: string }[]
    | undefined;
  for (const g of guilds ?? []) {
    const chs = (await (await get(`https://discord.com/api/v10/guilds/${g.id}/channels`, auth))?.json()) as
      | { id: string; name: string }[]
      | undefined;
    const hit = (chs ?? []).find((c) => c.name === name);
    if (hit) return (channelCache = hit.id);
  }
  return fail(`no discord channel named '${name}' visible to the bot`);
}

/** Never throws: a dead alert path must not hide the finding (the feedback
 * row is already written by then). Returns the transport used, or null. */
export async function sendAlert(text: string): Promise<string | null> {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (webhook) {
    const r = await get(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    return r?.ok ? "webhook" : null;
  }
  const token = process.env.DISCORD_BOT_TOKEN || sh("pass", ["show", "discord/bot-token"]).out;
  if (!token) return null;
  try {
    const ch = await alertChannel(token);
    const r = await get(`https://discord.com/api/v10/channels/${ch}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 1900) }),
    });
    return r?.ok ? "bot" : null;
  } catch {
    return null;
  }
}

// ---- the services ---------------------------------------------------------

const QUIET = process.argv.includes("--quiet");

export const SERVICES: Service[] = [
  {
    id: "auto-llm",
    project: "llm-hosting",
    // The LLM router: 8090 is the historic bind, 8091 the current one.
    probe: async () => {
      const url = await firstOk(["http://localhost:8090/health", "http://127.0.0.1:8091/health"]);
      const body = (await (await get(url))!.json()) as { ok?: boolean };
      return body.ok === true ? `${url} ok` : fail(`${url} not ok: ${JSON.stringify(body)}`);
    },
  },
  {
    id: "v100",
    project: "llm-hosting",
    // Local GPU inference (llama-server / vllm / sglang) behind provider `v100`.
    probe: async () => {
      const proc = sh("pgrep", ["-f", "llama-server|vllm|sglang"]);
      if (proc.rc !== 0) return fail("no llama-server/vllm/sglang process");
      const url = await firstOk([
        "http://127.0.0.1:8099/health",
        "http://127.0.0.1:8092/health",
        "http://127.0.0.1:1234/health",
      ]);
      return `${url} ok (pid ${proc.out.split("\n")[0]})`;
    },
  },
  {
    id: "webui",
    project: "arc-webui",
    probe: async () => `${await firstOk(["http://localhost:8080/"])} ok`,
  },
  {
    id: "discord",
    project: "arc-agents",
    // The alert path itself: a broken transport turns every other alert silent.
    probe: async () => {
      if (process.env.DISCORD_WEBHOOK_URL) {
        const r = await get(process.env.DISCORD_WEBHOOK_URL);
        return r?.status === 200 ? "webhook reachable" : fail(`webhook → ${r?.status ?? "unreachable"}`);
      }
      const token = process.env.DISCORD_BOT_TOKEN || sh("pass", ["show", "discord/bot-token"]).out;
      if (!token) return fail("no DISCORD_BOT_TOKEN and no pass entry discord/bot-token");
      const me = await get("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${token}` },
      });
      if (me?.status !== 200) return fail(`bot auth → ${me?.status ?? "unreachable"}`);
      const ch = await alertChannel(token);
      const read = await get(`https://discord.com/api/v10/channels/${ch}`, {
        headers: { Authorization: `Bot ${token}` },
      });
      return read?.status === 200 ? `bot posts to channel ${ch}` : fail(`channel ${ch} → ${read?.status ?? "unreachable"}`);
    },
  },
  {
    id: "trading",
    project: "trading",
    // ponytail: trading has no daemon — it is cron-driven (daily-cycle 13:00Z,
    // rebalance 13:45Z, both Mon-Fri), so "alive" == a log written recently.
    // 96h window spans a weekend plus a missed day without false-alarming.
    // Upgrade path: a per-stage heartbeat row once trading emits one.
    probe: async () => {
      const newest = newestLog(
        [join(HOME, "repos/trading/logs"), join(VAULT, "trading")],
        /\.log$/,
      );
      if (!newest) return fail("no trading logs found");
      const ageH = (Date.now() - newest) / 3_600_000;
      return ageH < 96
        ? `last trading log activity ${ageH.toFixed(1)}h ago`
        : fail(`no trading log activity for ${ageH.toFixed(1)}h (cron stalled?)`);
    },
  },
  {
    id: "ndivisible",
    project: "ndivisible",
    probe: async () => {
      const ps = sh("docker", ["ps", "--filter", "name=ndivisible-", "--format", "{{.Names}}"]);
      const up = ps.out.split("\n").filter(Boolean).sort();
      const missing = ["api", "web", "postgres"].filter((s) => !up.some((n) => n.includes(`ndivisible-${s}-`)));
      if (missing.length) return fail(`containers down: ${missing.join(", ")} (up: ${up.join(", ") || "none"})`);
      const pub = await get("https://app.ndivisible.com/api/health");
      return pub?.status === 200 ? `${up.join(", ")}; public 200` : fail(`public /api/health → ${pub?.status ?? "unreachable"}`);
    },
  },
];

// ---- the run --------------------------------------------------------------

export type Result = { id: string; project: string; ok: boolean; detail: string };

/** Probe everything, then reconcile ledger rows + alerts. Injected for tests. */
export async function runHealthMonitor(opts: {
  db: Database;
  services: Service[];
  notify: (text: string) => Promise<unknown>;
  now?: number;
  outDir?: string | null;
  quiet?: boolean;
  log?: (line: string) => void;
}): Promise<Result[]> {
  const { db, services, notify, outDir = OUT_DIR, quiet = QUIET, log = console.log } = opts;
  const results = await Promise.all(
    services.map(async ({ id, project, probe }) => {
      try {
        return { id, project, ok: true, detail: await probe() };
      } catch (e) {
        return { id, project, ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  for (const r of results) {
    const rowId = `hm-${r.id}`;
    const auto = {
      id: rowId,
      project: r.project,
      source: "auto-oversight",
      submitter: "health-monitor",
    };
    if (!r.ok) {
      // Insert-or-ignore IS the dedupe: a sustained outage changes nothing and
      // therefore alerts nothing. changes===1 ⇒ this is the transition.
      const ins = db
        .query(
          "insert or ignore into feedback (id, project, source, submitter, state, body_md, created_at) values (?,?,?,?,?,?,?)",
        )
        .run(rowId, r.project, "auto-oversight", "health-monitor", "OPEN", `**${r.id} DOWN** — ${r.detail}`, Date.now());
      if (ins.changes === 1) await notify(`🔴 **${r.id} DOWN** — ${r.detail}`);
    } else {
      const upd = db
        .query("update feedback set state='resolved', resolution=?, body_md=? where id=? and state='OPEN'")
        .run(`recovered ${new Date().toISOString()}`, `**${r.id} recovered** — ${r.detail}`, rowId);
      if (upd.changes === 1) await notify(`🟢 **${r.id} UP** — ${r.detail}`);
    }
    if (!quiet) log(`${r.ok ? "ok  " : "DOWN"} ${auto.id.padEnd(16)} ${r.detail}`);
  }

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString();
    const down = results.filter((r) => !r.ok);
    writeFileSync(
      join(outDir, "status.json"),
      `${JSON.stringify({ at: stamp, down: down.length, services: results }, null, 1)}\n`,
    );
    appendFileSync(
      join(outDir, "monitor.log"),
      `${stamp} ok=${results.length - down.length}/${results.length} down=[${down.map((d) => d.id).join(",")}]\n`,
    );
  }
  return results;
}

// ---- CLI ------------------------------------------------------------------

async function main() {
  const dry = process.argv.includes("--dry-run");
  const db = dry ? new Database(":memory:") : new Database(DB_PATH);
  if (dry) {
    db.run(
      "create table feedback (id text primary key, project text, source text, submitter text, state text, body_md text, created_at integer, resolution text)",
    );
  }
  db.run("PRAGMA busy_timeout=5000;"); // crons + webui share this db
  try {
    const results = await runHealthMonitor({
      db,
      services: SERVICES,
      notify: dry ? async () => null : sendAlert,
      outDir: dry ? null : OUT_DIR,
    });
    const down = results.filter((r) => !r.ok).map((r) => r.id);
    console.log(`health-monitor: ${results.length - down.length}/${results.length} up${down.length ? ` — DOWN: ${down.join(", ")}` : ""}`);
  } catch (e) {
    console.error(`health-monitor: run failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (import.meta.main) await main();