#!/usr/bin/env bun
// Queue CLI — the Driver's next-bead picker across every configured beads db. Port of driver-next.sh.
//   bun director/src/queue/cli.ts [N]     top N rows (default 1): dir, id, P<pri>, title (TSV)
// Env: QUEUE_DBS (file: one bd dir per line, # comments; default: cwd only), DRIVER_LANE (default "claude"),
//      SPRINT_STEER (default ./steer-<lane>.json), LANE_URL (laneproxy base URL; unset = no v100-starved row).
import { readFileSync } from "node:fs";
import { readSteer } from "../sprint/steer.ts";
import { format, rank, type Bead } from "./rank.ts";

export type Ctx = {
  dbs: string[];
  steer: string;
  laneUrl?: string;
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

// V100 up but idle (no lane:v100 bead running anywhere, laneproxy queue empty) → top row tells the
// Driver to feed it. A lane that answers non-200 is down, not starved. Fails closed: an unreadable
// db or /__lanes could hide a running bead, so either suppresses the row (the shell assumed idle).
function starved(c: Ctx): Bead | null {
  if (!c.laneUrl || c.exec(["curl", "-s", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}", `${c.laneUrl}/v1/models`]) !== "200") return null;
  const count = (args: string[]) => {
    const ns = c.dbs.map((d) => beads(c, d, args)?.length);
    return ns.length && ns.every((n) => n !== undefined) ? ns.reduce((a, n) => a! + n!, 0)! : null;
  };
  if (count(["list", "--status", "in_progress", "-l", "lane:v100", "--json", "--limit", "100"]) !== 0) return null;
  try {
    const l = JSON.parse(c.exec(["curl", "-s", "-m", "3", `${c.laneUrl}/__lanes`]));
    if (!Array.isArray(l.waiting) || !Array.isArray(l.slots)) return null;
    if (l.waiting.length + l.slots.filter((s: { lane: unknown }) => s.lane != null).length > 0) return null;
  } catch {
    return null;
  }
  const rdy = count(["ready", "--json", "-n", "100", "-l", "lane:v100", "--exclude-label", "qwen-failed,human"]) ?? 0;
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
  const out = format(rank(ready, claimed, readSteer(c.steer), c.now).slice(0, n));
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
    exec: (cmd) => Bun.spawnSync(cmd, { timeout: 60_000, stderr: "pipe" }).stdout.toString(),
    print: (s) => console.log(s),
    warn: (s) => console.error(s),
    now: Date.now(),
  };
  process.exit(next(c, Number(process.argv[2] ?? 1) || 1));
}
