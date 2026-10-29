#!/usr/bin/env bun
// Sprint CLI — the Driver's Sprint log (one bead, 60-min timebox). Port of ~/vault/director/scripts/sprint.ts.
//   bun director/src/sprint/cli.ts start <dir> <id>
//       claim + prep (bd memories; ke research when `ke` is on PATH) + consume operator steering.
//   bun director/src/sprint/cli.ts end <id> <done|checkpoint|blocked> "<finding>" [<metric>=<number> ...] [mission="<axis>: <improvement>"]
// Env: DRIVER_LANE (default "claude"), SPRINT_LOG (default ./sprints.jsonl), SPRINT_STEER (default ./steer-<lane>.json),
//      SPRINT_DIRS (":"-separated bd dirs searched when `end` has no logged start; default cwd).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { keywords, parseEnd, parseKe, parseMemories } from "./parse.ts";
import { consumeSteer } from "./steer.ts";

export type Ctx = {
  lane: string;
  log: string;
  steer: string;
  dirs: string[];
  exec: (cmd: string[], timeoutMs?: number) => string; // stdout, "" on failure
  claim: (dir: string, id: string) => boolean; // false = refused (already claimed)
  hasKe: boolean;
  print: (s: string) => void;
  now: () => Date;
};

const append = (c: Ctx, e: object) =>
  appendFileSync(c.log, JSON.stringify({ ts: c.now().toISOString(), lane: c.lane, ...e }) + "\n");

const showBead = (c: Ctx, dir: string, id: string, timeoutMs?: number) => {
  try {
    const j = JSON.parse(c.exec(["bd", "-C", dir, "show", id, "--json"], timeoutMs));
    const b = Array.isArray(j) ? j[0] : j;
    return b?.id === id ? b : null;
  } catch {
    return null;
  }
};

export function start(c: Ctx, dir: string, id: string): number {
  const b = showBead(c, dir, id);
  if (!b) return c.print(`no bead ${id} in ${dir}`), 2;
  const claimed = c.claim(dir, id);
  const seen = new Set<string>();
  const words = keywords(b.title);
  const mem = words
    .flatMap((k) => parseMemories(c.exec(["bd", "-C", dir, "memories", k])))
    .filter((m) => !seen.has(m.key) && seen.add(m.key))
    .slice(0, 6);
  const ke = c.hasKe ? parseKe(c.exec(["ke", "research", b.title])).slice(0, 5) : [];
  const notes = consumeSteer(c.steer, id);
  const project = dir.replace(/\/+$/, "").split("/").pop();
  append(c, { ev: "start", dir, project, id, title: b.title, priority: b.priority, mem, ke, steer: notes });
  c.print(`▶ ${id} P${b.priority} ${b.title}${claimed ? "" : "  (claim refused — already claimed? take over with a note)"}`);
  if (notes.length) c.print(`STEERING from operator (act on these first):\n${notes.map((n) => `  - ${n.text}`).join("\n")}`);
  c.print(`MEMORIES (bd memories ${words.join(" | ")}):\n${mem.map((m) => `  ${m.key}: ${m.text}`).join("\n") || "  none"}`);
  if (c.hasKe) c.print(`KE (ke research):\n${ke.map((k) => `  [${k.score}%] ${k.title} → ${k.path}`).join("\n") || "  none"}`);
  return 0;
}

export function end(c: Ctx, args: string[]): number {
  const e = parseEnd(args);
  if ("error" in e) return c.print(e.error), 2;
  // No logged start (bead begun before the Sprint protocol, or start skipped): carry the bead's
  // identity on the end so the dashboard can still show the finding.
  const started =
    existsSync(c.log) &&
    readFileSync(c.log, "utf8").split("\n").some((l) => l.includes(`"ev":"start"`) && l.includes(`"id":"${e.id}"`));
  let who = {};
  if (!started)
    for (const dir of c.dirs) {
      const b = showBead(c, dir, e.id, 15_000);
      if (b) { who = { dir, project: dir.replace(/\/+$/, "").split("/").pop(), title: b.title, priority: b.priority, nostart: true }; break; }
    }
  append(c, { ev: "end", ...e, ...who });
  c.print(`■ ${e.id} ${e.outcome}`);
  return 0;
}

const USAGE = 'usage: cli.ts start <dir> <id> | end <id> <done|checkpoint|blocked> "<finding>" [metric=N ...] [mission="…"]';

if (import.meta.main) {
  const lane = process.env.DRIVER_LANE ?? "claude";
  const run = (cmd: string[], timeout = 120_000) => Bun.spawnSync(cmd, { timeout, stderr: "pipe" });
  const c: Ctx = {
    lane,
    log: process.env.SPRINT_LOG ?? "sprints.jsonl",
    steer: process.env.SPRINT_STEER ?? `steer-${lane}.json`,
    dirs: (process.env.SPRINT_DIRS ?? process.cwd()).split(":").filter(Boolean),
    exec: (cmd, t) => run(cmd, t).stdout.toString(),
    claim: (dir, id) => run(["bd", "-C", dir, "update", id, "--claim"]).exitCode === 0,
    hasKe: Bun.which("ke") !== null,
    print: (s) => console.log(s),
    now: () => new Date(),
  };
  const [cmd, ...a] = process.argv.slice(2);
  const rc = cmd === "start" && a.length >= 2 ? start(c, a[0]!, a[1]!) : cmd === "end" ? end(c, a) : (console.error(USAGE), 2);
  process.exit(rc);
}
