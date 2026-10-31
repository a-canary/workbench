#!/usr/bin/env bun
// Queue CLI — the Driver's next-bead picker across every configured beads db. Port of driver-next.sh.
//   bun director/src/queue/cli.ts [N]     top N rows (default 1): dir, id, P<pri>, title (TSV)
// Env: QUEUE_DBS (file: one bd dir per line, # comments; default: cwd only), DRIVER_LANE (default "claude"),
//      SPRINT_STEER (default ./steer-<lane>.json).
import { readFileSync } from "node:fs";
import { readSteer } from "../sprint/steer.ts";
import { format, rank, type Bead, type Row } from "./rank.ts";
import { fetchLimits } from "../budget/fetch.ts";
import { type Limit } from "../budget/meter.ts";
import { burnGate } from "../budget/burn.ts";

export type Ctx = {
  dbs: string[];
  steer: string;
  limits?: Limit[] | null;
  silos?: Record<string, string>;
  exec: (cmd: string[]) => string; // stdout, "" on failure
  print: (s: string) => void;
  warn: (s: string) => void;
  now: number;
};

// QUEUE_DBS line: "<dir> [silo]". ponytail: whitespace splits fields, so a dir containing spaces is unsupported.
const dbLines = (path: string): string[][] =>
  readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
export const readDbs = (path: string): string[] => dbLines(path).map((f) => f[0]!);
export const readSilos = (path: string): Record<string, string> =>
  Object.fromEntries(dbLines(path).filter((f) => f[1]).map((f) => [f[0]!, f[1]!]));

const beads = (c: Ctx, dir: string, args: string[]): Bead[] | null => {
  try {
    const j = JSON.parse(c.exec(["bd", "-C", dir, ...args]));
    return Array.isArray(j) ? j.map((b) => ({ ...b, dir })) : null;
  } catch {
    return null;
  }
};

export function next(c: Ctx, n: number): number {
  const ready: Bead[] = [];
  const claimed: Bead[] = [];
  let read = 0;
  for (const d of c.dbs) {
    const r = beads(c, d, ["ready", "--json", "--limit", "1000", "--exclude-label", "human,lane:v100,lane:free", "--exclude-type", "epic"]);
    const p = beads(c, d, ["list", "--status", "in_progress", "--json", "--limit", "1000"]);
    if (!r || !p) c.warn(`queue: unreadable beads db ${d}`);
    else read++;
    ready.push(...(r ?? []));
    claimed.push(...(p ?? []));
  }
  let held: { silo: string; g: { start: boolean; reason: string; burn: number | null } }[] = [];
  if (c.limits !== undefined) {
    const kept: Bead[] = [];
    for (const b of ready) {
      const silo = (b.labels ?? []).includes("critical") ? "critical" : c.silos?.[b.dir] ?? "public";
      const g = burnGate(c.limits ?? [], silo, c.now);
      if (g.start) kept.push(b);
      else held.push({ silo, g });
    }
    ready.length = 0;
    ready.push(...kept);
  }
  let rows = rank(ready, claimed, readSteer(c.steer), c.now);
  if (held.length > 0) {
    const g = held[0]!.g;
    const why = g.reason === "burn" ? `burn ${g.burn!.toFixed(2)}` : g.reason;
    const nHeld = held.length;
    const heldSilos = [...new Set(held.map((h) => h.silo))].join(",");
    rows = [{
      dir: "-", id: "budget-hold", priority: 0, created_at: "0000",
      title: `[budget-hold] ${why}: ${nHeld} ready bead${nHeld === 1 ? "" : "s"} held (${heldSilos})`,
      pinned: false,
    } as Row, ...rows];
  }
  const out = format(rows.slice(0, n));
  if (out) c.print(out);
  return c.dbs.length && !read ? 1 : 0; // every db unreadable ≠ an empty queue
}

if (import.meta.main) {
  const lane = process.env.DRIVER_LANE ?? "claude";
  const dbFile = process.env.QUEUE_DBS;
  const c: Ctx = {
    dbs: dbFile ? readDbs(dbFile) : [process.cwd()], // a configured but missing file throws: fail loud
    steer: process.env.SPRINT_STEER ?? `steer-${lane}.json`,
    limits: process.env.BUDGET_GATE === "off" ? undefined : null,
    silos: dbFile ? readSilos(dbFile) : {},
    exec: (cmd) => Bun.spawnSync(cmd, { timeout: 60_000, stderr: "pipe" }).stdout.toString(),
    print: (s) => console.log(s),
    warn: (s) => console.error(s),
    now: Date.now(),
  };
  if (c.limits !== undefined) c.limits = await fetchLimits();
  process.exit(next(c, Number(process.argv[2] ?? 1) || 1));
}
