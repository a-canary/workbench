#!/usr/bin/env bun
// capacity.ts — advisory shared-capacity CLI for directors.
// RED LINE: ANY internal failure prints {"action":"run","fail_open":true} and
// exits 0. This tool may never block a dispatch.
//
//   bun capacity.ts record  --provider claude --tokens 12000 --status ok|429 [--ts <unix>] [--meta s]
//   bun capacity.ts headroom [--provider claude]
//   bun capacity.ts route   --provider claude --lane critical|research|standard [--ctx N] [--parked-min N]
//   bun capacity.ts stats
//
// DB: $CAPACITY_DB (default ~/vault/capacity.db), bun:sqlite, WAL, single table.

import { Database } from "bun:sqlite";
import { estimate, type Outcome } from "./estimator.ts";
import { arbitrate, type Lane } from "./arbitrate.ts";

const DB_PATH = process.env.CAPACITY_DB ?? `${process.env.HOME}/vault/capacity.db`;
const RETAIN_DAYS = 30;

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const failOpen = (e: unknown): never => {
  console.log(JSON.stringify({ action: "run", fail_open: true, reason: String(e).slice(0, 200) }));
  process.exit(0);
};

try {
  const d = new Database(DB_PATH, { create: true });
  d.exec("PRAGMA journal_mode=WAL");
  d.exec("CREATE TABLE IF NOT EXISTS outcomes (ts INTEGER, provider TEXT, tokens INTEGER, status TEXT, meta TEXT)");

  const cmd = process.argv[2];
  if (cmd === "record") {
    const provider = arg("provider");
    if (!provider) throw new Error("record needs --provider");
    d.query("INSERT INTO outcomes (ts, provider, tokens, status, meta) VALUES (?,?,?,?,?)").run(
      Number(arg("ts") ?? Math.floor(Date.now() / 1000)),
      provider,
      Number(arg("tokens") ?? 0),
      arg("status") ?? "ok",
      arg("meta") ?? null,
    );
    console.log(JSON.stringify({ ok: true }));
  } else if (cmd === "headroom" || cmd === "route" || cmd === "stats") {
    const cutoff = Math.floor(Date.now() / 1000) - RETAIN_DAYS * 86400;
    const rows = d.query("SELECT ts, provider, tokens, status FROM outcomes WHERE ts > ?").all(cutoff) as Outcome[];
    if (cmd === "stats") {
      const byProv: Record<string, { rows: number; blocks429: number }> = {};
      for (const r of rows) {
        byProv[r.provider] ??= { rows: 0, blocks429: 0 };
        byProv[r.provider].rows++;
        if (r.status === "429") byProv[r.provider].blocks429++;
      }
      console.log(JSON.stringify({ db: DB_PATH, since: cutoff, providers: byProv }));
    } else if (cmd === "headroom") {
      const provs = arg("provider") ? [arg("provider")!] : [...new Set(rows.map((r) => r.provider))].sort();
      console.log(JSON.stringify(provs.map((p) => estimate(rows, p))));
    } else {
      const provider = arg("provider");
      if (!provider) throw new Error("route needs --provider");
      const lane = (arg("lane") ?? "standard") as Lane;
      const verdict = arbitrate(estimate(rows, provider), lane, {
        ctx: arg("ctx") ? Number(arg("ctx")) : undefined,
        parkedMinutes: arg("parked-min") ? Number(arg("parked-min")) : undefined,
      });
      console.log(JSON.stringify(verdict));
    }
  } else {
    throw new Error(`unknown cmd '${cmd ?? ""}' — usage: record|headroom|route|stats`);
  }
} catch (e) {
  failOpen(e);
}
