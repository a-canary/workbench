#!/usr/bin/env bun
// Queue CLI — the Driver's next-bead picker across every configured beads db. Port of driver-next.sh.
//   bun director/src/queue/cli.ts [N]     top N rows (default 1): dir, id, P<pri>, title (TSV)
// Env: QUEUE_DBS (file: one bd dir per line, # comments; default: cwd only), DRIVER_LANE (default "claude"),
//      SPRINT_STEER (default ./steer-<lane>.json), LANE_URL (laneproxy base URL; unset = no v100-starved row).
import { readFileSync } from "node:fs";
import { readSteer } from "../sprint/steer.ts";
import { format, rank, type Bead, type Row } from "./rank.ts";
import { fetchMeter } from "../budget/fetch.ts";
import { budgetGate, type Meter } from "../budget/meter.ts";

export type Ctx = {
  dbs: string[];
  steer: string;
  laneUrl?: string;
  meter?: Meter | null;
  exec: (cmd: string[]) => string; // stdout, "" on failure
  print: (s: string) => void;
  warn: (s: string) => void;
  now: number;
};

export const readDbs = (path: string): string[] =>
  readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

const beads = (c: Ctx, dir: string, args: string[]): Bead[] | null => {
  try {
    const j = JSON.parse(c.exec(["bd", "-C", dir, ...args]));
    return Array.isArray(j) ? j.map((b) => ({ ...b, dir })) : null;
  } catch {
    return null;
  }
};

// Sum a bd query across every configured db; null if any db is unreadable (fail closed).
const countAcross = (c: Ctx, args: string[]): number | null => {
  const ns = c.dbs.map((d) => beads(c, d, args)?.length);
  return ns.length && ns.every((n) => n !== undefined) ? ns.reduce((a, n) => a! + n!, 0)! : null;
};

const V100_READY = ["ready", "--json", "-n", "100", "-l", "lane:v100", "--exclude-label", "qwen-failed,human"];

// V100 up but idle (no lane:v100 bead running anywhere, laneproxy queue empty) → top row tells the
// Driver to feed it. A lane that answers non-200 is down, not starved. Fails closed: an unreadable
// db or /__lanes could hide a running bead, so either suppresses the row (the shell assumed idle).
function starved(c: Ctx): Bead | null {
  if (!c.laneUrl || c.exec(["curl", "-s", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}", `${c.laneUrl}/v1/models`]) !== "200") return null;
  if (countAcross(c, ["list", "--status", "in_progress", "-l", "lane:v100", "--json", "--limit", "100"]) !== 0) return null;
  try {
    const l = JSON.parse(c.exec(["curl", "-s", "-m", "3", `${c.laneUrl}/__lanes`]));
    if (!Array.isArray(l.waiting) || !Array.isArray(l.slots)) return null;
    if (l.waiting.length + l.slots.filter((s: { lane: unknown }) => s.lane != null).length > 0) return null;
  } catch {
    return null;
  }
  const rdy = countAcross(c, V100_READY) ?? 0;
  return {
    dir: "-", id: "v100-starved", priority: 0, created_at: "0000", updated_at: "", labels: [], issue_type: "task", status: "open",
    title: `[v100-starved] V100 idle (${rdy} lane:v100 ready, 0 running): decompose one into lane-run RED-test beads, then run lane-run`,
  };
}

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
  const s = starved(c);
  if (s) ready.push(s);
  let rows = rank(ready, claimed, readSteer(c.steer), c.now);
  if (c.meter !== undefined) {
    const localQueued = countAcross(c, V100_READY) ?? 0;
    const g = budgetGate(c.meter, localQueued);
    if (!g.claude) {
      rows = rows.filter((r) => r.title.startsWith("[stale-claim] "));
      const util = c.meter ? ` util=${Math.round(c.meter.util * 100)}%` : "";
      rows = [{
        dir: "-", id: "budget-hold", priority: 0, created_at: "0000",
        title: `[budget-hold] ${g.reason}${util}: ${localQueued} lane:v100 queued — work the local lane first`,
        pinned: false,
      } as Row, ...rows];
    }
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
    laneUrl: process.env.LANE_URL,
    meter: process.env.BUDGET_GATE === "off" ? undefined : null,
    exec: (cmd) => Bun.spawnSync(cmd, { timeout: 60_000, stderr: "pipe" }).stdout.toString(),
    print: (s) => console.log(s),
    warn: (s) => console.error(s),
    now: Date.now(),
  };
  if (c.meter !== undefined) c.meter = await fetchMeter();
  process.exit(next(c, Number(process.argv[2] ?? 1) || 1));
}
