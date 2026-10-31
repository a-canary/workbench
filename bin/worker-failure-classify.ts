// worker-failure-classify — deterministic, no-LLM triage of blocked v100 worker failures (wb-3xh tracer).
//
//   bun bin/worker-failure-classify.ts [--sprints F] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//                                      [--notes-dir DIR] [--log-dir DIR]
//
// Cases = lane=v100, ev=end, outcome=blocked, finding="worker failed" rows. Each row is paired (aligned from the
// newest end) with the bead's `qwen-failed:` notes that carry a `(log: /tmp/lane-run-*)` pointer; the note plus the
// log it points to is the evidence for that run. Rules run first-match-wins, H* (HARNESS) then M* (MODEL); no match
// -> "judge". A bead's class is its LAST run's class. Rules are the prototype's
// (~/vault/director/worker-failures/2026-10-31-cases.md); H5 there ("worker said pass + infra string") is H2 and is
// not a separate rule. Output: JSON {counts, cases:[{id, rule, class, runs:[...]}]}.
//
// Inputs: sprints.jsonl, `bd show <id> --json` run in the repo dir of the bead's sprint `start` row (or
// <notes-dir>/<id>.json for offline/fixtures), and lane-run logs (path from the note; <log-dir>/<basename> overrides).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type Klass = "HARNESS" | "MODEL" | "judge";
export type Run = { rule: string; klass: Klass; note: string };
export type Case = { id: string; rule: string; class: Klass; runs: Run[] };

const isTestPath = (p: string) => /(^|[/._-])(tests?|spec)([/._-]|$)|\.(test|spec)\./.test(p);
const after = (s: string, marker: RegExp) => { const m = marker.exec(s); return m ? s.slice(m.index) : ""; };

// Failing test names in a runner output block: bun `(fail) name [1ms]`, vitest `FAIL  file > name`.
export function failNames(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)) out.add(m[1]);
  for (const m of s.matchAll(/^ *FAIL +\S+ > (.+?)\s*$/gm)) out.add(m[1]);
  return out;
}

const tscErrFiles = (s: string) => [...s.matchAll(/^(\S+?)\(\d+,\d+\): error TS\d+/gm)].map((m) => m[1]);
const stem = (p: string) => basename(p).replace(/\.(test|spec)\.[a-z]+$|\.[a-z]+$/i, "");

// Classify one run from its bead note line + the lane-run log it points to.
export function classifyRun(note: string, log: string): { rule: string; klass: Klass } {
  const text = `${note}\n${log}`;
  const red = log.split(/^worker-task: GREEN:/m)[0];
  const greenCmd = /^worker-task: GREEN: (.*)$/m.exec(log)?.[1] ?? /GREEN: (.*?) test still fails/.exec(note)?.[1] ?? "";
  const green = after(log, /^worker-task: GREEN:/m);
  const H = (rule: string) => ({ rule, klass: "HARNESS" as const });
  const M = (rule: string) => ({ rule, klass: "MODEL" as const });

  // H1 prep: lane-run refused the bead/branch before any worker work.
  if (/bead lacks Branch:|Branch: must be lane\/|already exists|could not check out/.test(text)) return H("H1");
  // H2 sandbox: jail infra error in the GREEN phase.
  if (/bun: not found|EROFS|Failed to resolve import|not a git repository/.test(green)) return H("H2");
  // H3 guard misfire: RED commit empty, or the "protected" list holds a non-test path.
  if (/HEAD \(RED commit\) touches no files/.test(text)) return H("H3");
  const prot = /modified protected test files: (.*)/.exec(text)?.[1];
  if (prot && prot.split(/\s+/).filter(Boolean).some((p) => !isTestPath(p))) return H("H3");
  // H4 baseline red: unscoped whole-project tsc, and no tsc error is in a file the worker could have touched
  // (a test file named in GREEN, or its implementation sibling).
  if (/tsc --noEmit -p \.\s*$/.test(greenCmd)) {
    const errs = tscErrFiles(green);
    const scope = new Set([...greenCmd.matchAll(/\S+\.(?:test|spec)\.[a-z]+/g)].map((m) => stem(m[0])));
    if (errs.length && errs.every((f) => !scope.has(stem(f)))) return H("H4");
  }
  // M1 timeout.
  if (/worker-sandbox: timeout after/.test(text)) return M("M1");
  // M2 not-green: a test that failed at RED is still failing at GREEN.
  const redFail = failNames(red);
  if ([...failNames(green)].some((n) => redFail.has(n))) return M("M2");
  // M3 type/compile error in the file the worker wrote (sibling of the GREEN test file).
  const scope = new Set([...greenCmd.matchAll(/\S+\.(?:test|spec)\.[a-z]+/g)].map((m) => stem(m[0])));
  if (tscErrFiles(green).some((f) => scope.has(stem(f)))) return M("M3");
  return { rule: "none", klass: "judge" };
}

type Row = { ts: string; id: string; finding?: string; lane?: string; ev?: string; outcome?: string; dir?: string };

export function classify(sprints: string, opts: { from?: string; to?: string; notes: (id: string, dir: string) => string; log: (path: string) => string }) {
  const rows: Row[] = sprints.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const dirOf = new Map<string, string>();
  for (const r of rows) if (r.ev === "start" && r.lane === "v100" && r.dir) dirOf.set(r.id, r.dir);
  const inRange = (ts: string) => (!opts.from || ts.slice(0, 10) >= opts.from) && (!opts.to || ts.slice(0, 10) <= opts.to);
  const fails = rows.filter((r) => r.lane === "v100" && r.ev === "end" && r.outcome === "blocked" && r.finding === "worker failed" && inRange(r.ts));
  const ids = [...new Set(fails.map((r) => r.id))];
  const cases: Case[] = ids.map((id) => {
    const nrows = fails.filter((r) => r.id === id).length;
    const notes = opts.notes(id, dirOf.get(id) ?? "").split("\n").filter((n) => /^qwen-failed:/.test(n) && /\(log: \S+\)/.test(n));
    const runNotes = notes.slice(Math.max(0, notes.length - nrows));
    const runs: Run[] = runNotes.map((note) => {
      const path = /\(log: (\S+?)\)/.exec(note)![1];
      return { ...classifyRun(note, opts.log(path)), note: note.slice(0, 160) };
    });
    const last = runs[runs.length - 1] ?? { rule: "none", klass: "judge" as Klass };
    return { id, rule: last.rule, class: last.klass, runs };
  });
  const counts = { HARNESS: 0, MODEL: 0, judge: 0 };
  for (const c of cases) counts[c.class]++;
  return { counts, cases };
}

function main() {
  const a = process.argv.slice(2);
  const arg = (k: string, d?: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const notesDir = arg("--notes-dir");
  const logDir = arg("--log-dir");
  const sprints = readFileSync(arg("--sprints", join(process.env.HOME ?? "", "vault/director/sprints.jsonl"))!, "utf8");
  const out = classify(sprints, {
    from: arg("--from"),
    to: arg("--to"),
    notes: (id, dir) => {
      const raw = notesDir ? readFileSync(join(notesDir, `${id}.json`), "utf8") : execFileSync("bd", ["-C", dir, "show", id, "--json"], { encoding: "utf8" });
      return (JSON.parse(raw)[0]?.notes as string) ?? "";
    },
    log: (p) => { const f = logDir ? join(logDir, basename(p)) : p; return existsSync(f) ? readFileSync(f, "utf8") : ""; },
  });
  console.log(JSON.stringify(out, null, 2));
}

if (import.meta.main) main();
