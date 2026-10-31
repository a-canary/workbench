// worker-failure-classify — deterministic, no-LLM triage of blocked v100 worker failures (wb-3xh tracer).
//
//   bun bin/worker-failure-classify.ts [--sprints F] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//                                      [--notes-dir DIR] [--log-dir DIR] [--file] [--queue F] [--bd-dir DIR]
//
// Cases = lane=v100, ev=end, outcome=blocked rows whose finding is a worker run's: "worker failed[: cause]",
// "infra[: cause]" or "baseline red[: cause]". Each row is paired (aligned from the newest end, per kind) with the
// bead's note of that kind (`qwen-failed:` / `lane-infra:` / `human:`) carrying a `(log: …)` pointer; the sprint
// finding, the note and the log it points to are the evidence for that run. Rules run first-match-wins, H* (HARNESS) then M* (MODEL); no match
// -> "judge". A bead's class is its LAST run's class. Rules are the prototype's
// (~/vault/director/worker-failures/2026-10-31-cases.md); H5 there ("worker said pass + infra string") is H2 and is
// not a separate rule. Output: JSON {counts, cases:[{id, rule, class, runs:[...]}], plan}.
//
// plan (dry-run unless --file): HARNESS -> one bug bead per new shape (key = rule + normalized cause, label
// `shape:<key>`; skipped while an open bead carries that label) in --bd-dir (default ~/repos/workbench);
// MODEL -> one line per case appended to --queue (sanitize-queue.jsonl, wb-rf4 input; dedupe id+ts); judge -> counted.
//
// Inputs: sprints.jsonl, `bd show <id> --json` run in the repo dir of the bead's sprint `start` row (or
// <notes-dir>/<id>.json for offline/fixtures), and lane-run logs (path from the note; <log-dir>/<basename> overrides).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type Klass = "HARNESS" | "MODEL" | "judge";
export type Run = { rule: string; klass: Klass; cause?: string; note: string; ts: string };
export type Case = { id: string; rule: string; class: Klass; runs: Run[]; error?: string };

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
// label-safe cause: lowercase words, paths and numbers dropped, at most 4 words
export const slug = (s: string) =>
  s.toLowerCase().replace(/\S*\/\S*|\d+/g, " ").replace(/[^a-z]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 4).join("-") || "unknown";
const stem = (p: string) => basename(p).replace(/\.(test|spec)\.[a-z]+$|\.[a-z]+$/i, "");

// Classify one run from its bead note line + the lane-run log it points to.
// lane-run's sprint finding (PR #81/#83, wb-it5): "worker failed: worker-introduced: a; target-still-failing: b;
// baseline-red: c", "baseline red: …", "infra[: startup crash: …]". Read from sprints.jsonl, never the log: the
// log carries worker-controlled text that could forge a label.
export function findingLabel(finding: string): Klass | undefined {
  if (/^infra\b/.test(finding) || /^baseline red\b/.test(finding)) return "HARNESS";
  const d = /^worker failed: (.*)$/.exec(finding)?.[1] ?? "";
  if (/^timeout\b/.test(d)) return undefined; // the worker's own timeout: M1
  // Anchored: lane-run writes labels in fixed order; mid-string text is a worker-chosen test name ("test $t").
  if (/^(worker-introduced|target-still-failing): /.test(d)) return "MODEL";
  if (/^baseline-red: /.test(d)) return "HARNESS";
  return undefined; // "baseline unknown", "test X", plain "worker failed": no baseline verdict
}

export function classifyRun(note: string, log: string, finding = ""): { rule: string; klass: Klass; cause?: string } {
  const text = `${note}\n${log}`;
  const red = log.split(/^worker-task: GREEN:/m)[0];
  const greenCmd = /^worker-task: GREEN: (.*)$/m.exec(log)?.[1] ?? /GREEN: (.*?) test still fails/.exec(note)?.[1] ?? "";
  const green = after(log, /^worker-task: GREEN:/m);
  const H = (rule: string, cause: string) => ({ rule, klass: "HARNESS" as const, cause: slug(cause) });
  const M = (rule: string) => ({ rule, klass: "MODEL" as const });

  // H1 prep: lane-run refused the bead/branch before any worker work.
  // Note text only, or whole-line lane-run prep output in the log: worker test output must not trip it.
  const prep = /bead lacks Branch:|Branch: must be lane\/|already exists|could not check out/.exec(note)?.[0] ?? /^could not check out /m.exec(log)?.[0];
  if (prep) return H("H1", prep);
  // H2 sandbox: jail infra error in the GREEN phase.
  const jail = /bun: not found|EROFS|Failed to resolve import|not a git repository/.exec(green)?.[0];
  if (jail) return H("H2", jail);
  // H3 guard misfire: RED commit empty, or the "protected" list holds a non-test path.
  if (/HEAD \(RED commit\) touches no files/.test(text)) return H("H3", "empty red commit");
  const prot = /modified protected test files: (.*)/.exec(text)?.[1];
  if (prot && prot.split(/\s+/).filter(Boolean).some((p) => !isTestPath(p))) return H("H3", "protected non test");
  // H4 baseline diff from lane-run's labels: infra/lane-infra and baseline-red-only -> HARNESS; any
  // worker-introduced or target-still-failing failure -> MODEL (M4), even beside a baseline-red one.
  const infra = /^infra\b/.test(finding) ? finding : /^lane-infra:/.test(note) ? `infra ${note.replace(/^lane-infra:|\(log:.*$/g, "")}` : "";
  if (infra) return H("H4", infra);
  const lab = findingLabel(finding);
  if (lab === "HARNESS") return H("H4", "baseline red");
  if (lab === "MODEL") return M("M4");
  // H4 legacy (rows without labels, before PR #81): unscoped whole-project tsc, and no tsc error is in a file the worker could have touched
  // (a test file named in GREEN, or its implementation sibling).
  if (/tsc --noEmit -p \.\s*$/.test(greenCmd)) {
    const errs = tscErrFiles(green);
    const scope = new Set([...greenCmd.matchAll(/\S+\.(?:test|spec)\.[a-z]+/g)].map((m) => stem(m[0])));
    if (errs.length && errs.every((f) => !scope.has(stem(f)))) return H("H4", "whole project tsc");
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

// note prefix lane-run writes for a sprint finding's kind (lane-run fail()); undefined = not a worker run
const noteKind = (f: string) => (/^worker failed\b/.test(f) ? "qwen-failed" : /^infra\b/.test(f) ? "lane-infra" : /^baseline red\b/.test(f) ? "human" : undefined);

type Row = { ts: string; id: string; finding?: string; lane?: string; ev?: string; outcome?: string; dir?: string };

export function classify(sprints: string, opts: { from?: string; to?: string; notes: (id: string, dir: string) => string; log: (path: string) => string; noDirOk?: boolean }) {
  const rows: Row[] = [];
  let skipped = 0;
  for (const l of sprints.split("\n").filter(Boolean)) {
    try { const r = JSON.parse(l); if (r && typeof r === "object") rows.push(r); else skipped++; } catch { skipped++; }
  }
  const dirOf = new Map<string, string>();
  for (const r of rows) if (r.ev === "start" && r.lane === "v100" && r.dir) dirOf.set(r.id, r.dir);
  const inRange = (ts: string) => (!opts.from || ts.slice(0, 10) >= opts.from) && (!opts.to || ts.slice(0, 10) <= opts.to);
  const fails = rows.filter((r) => r.lane === "v100" && r.ev === "end" && r.outcome === "blocked" && !!noteKind(r.finding ?? "") && inRange(r.ts));
  const ids = [...new Set(fails.map((r) => r.id))];
  const cases: Case[] = ids.map((id) => {
    const mine = fails.filter((r) => r.id === id);
    const dir = dirOf.get(id);
    const judge = (error: string): Case => ({ id, rule: "none", class: "judge", runs: [], error });
    if (!dir && !opts.noDirOk) return judge("no start row with dir for bead");
    let raw: string;
    try { raw = opts.notes(id, dir ?? ""); } catch (e) { return judge(`bd show failed: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`); }
    const lines = raw.split("\n").filter((n) => /\(log: \S+\)/.test(n));
    // pair each row with its kind's notes from the newest end; a row with no note left is dropped
    const left = new Map<string, string[]>();
    const runs: Run[] = [];
    for (const r of [...mine].reverse()) {
      const k = noteKind(r.finding ?? "")!;
      if (!left.has(k)) left.set(k, lines.filter((n) => n.startsWith(`${k}: `)));
      const note = left.get(k)!.pop();
      if (!note) continue;
      const path = /\(log: (\S+?)[;)]/.exec(note)![1];
      runs.unshift({ ...classifyRun(note, opts.log(path), r.finding ?? ""), note: note.slice(0, 160), ts: r.ts });
    }
    const last = runs[runs.length - 1] ?? { rule: "none", klass: "judge" as Klass };
    return { id, rule: last.rule, class: last.klass, runs };
  });
  const counts = { HARNESS: 0, MODEL: 0, judge: 0 };
  for (const c of cases) counts[c.class]++;
  return { counts, skipped, cases };
}

type Out = ReturnType<typeof classify>;
export const shapeKey = (c: Case) => `${c.rule}-${c.runs[c.runs.length - 1]?.cause ?? "unknown"}`.toLowerCase();

// What the sweep would file: new HARNESS shapes as beads, MODEL cases as sanitize-queue rows, judge as a count.
// hasOpenShape(key) / queued("id ts") say what already exists; both are injected so tests need no bd or vault.
export function plan(out: Out, hasOpenShape: (key: string) => boolean, queued: Set<string>) {
  const shapes = new Map<string, Case[]>();
  for (const c of out.cases.filter((c) => c.class === "HARNESS")) shapes.set(shapeKey(c), [...(shapes.get(shapeKey(c)) ?? []), c]);
  const beads = [...shapes].filter(([key]) => !hasOpenShape(key)).map(([key, cs]) => ({
    key,
    title: `worker-failure shape ${key}: ${cs.length} case${cs.length > 1 ? "s" : ""} (e.g. ${cs.slice(0, 3).map((c) => c.id).join(", ")})`,
    description: [`shape: ${key}`, `Filed by bin/worker-failure-classify.ts --file (wb-3xh).`, "", ...cs.map((c) => `- ${c.id}: ${c.runs[c.runs.length - 1]?.note ?? ""}`)].join("\n"),
  }));
  const queue = out.cases
    .filter((c) => c.class === "MODEL")
    .map((c) => { const r = c.runs[c.runs.length - 1]; return { id: c.id, ts: r.ts, rule: c.rule, note: r.note }; })
    .filter((q) => !queued.has(`${q.id} ${q.ts}`));
  return { beads, queue, judge: out.counts.judge };
}

// Apply a plan. bd(args) runs `bd -C <bd-dir> ...args` and returns stdout; injected for tests.
export function file(p: ReturnType<typeof plan>, bd: (args: string[]) => string, queuePath: string) {
  const filed = p.beads.map((b) => bd(["create", "--title", b.title, "-d", b.description, "-t", "bug", "-p", "2", "-l", `shape:${b.key}`, "--silent"]).trim());
  if (p.queue.length) {
    mkdirSync(dirname(queuePath), { recursive: true });
    appendFileSync(queuePath, p.queue.map((q) => `${JSON.stringify(q)}\n`).join(""));
  }
  return { filed, appended: p.queue.length };
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
    noDirOk: !!notesDir, // offline notes are keyed by id, so no repo dir is needed
    notes: (id, dir) => {
      const raw = notesDir ? readFileSync(join(notesDir, `${id}.json`), "utf8") : execFileSync("bd", ["-C", dir, "show", id, "--json"], { encoding: "utf8" });
      return (JSON.parse(raw)[0]?.notes as string) ?? "";
    },
    log: (p) => { const f = logDir ? join(logDir, basename(p)) : p; return existsSync(f) ? readFileSync(f, "utf8") : ""; },
  });
  const home = process.env.HOME ?? "";
  const bdDir = arg("--bd-dir", join(home, "repos/workbench"))!;
  const queuePath = arg("--queue", join(home, "vault/director/worker-failures/sanitize-queue.jsonl"))!;
  const bd = (args: string[]) => execFileSync("bd", ["-C", bdDir, ...args], { encoding: "utf8" });
  const queued = new Set(
    (existsSync(queuePath) ? readFileSync(queuePath, "utf8") : "").split("\n").filter(Boolean).flatMap((l) => {
      try { const q = JSON.parse(l); return [`${q.id} ${q.ts}`]; } catch { return []; }
    }),
  );
  const p = plan(out, (key) => (JSON.parse(bd(["list", "--label", `shape:${key}`, "--json"]) || "[]") as unknown[]).length > 0, queued);
  const result = a.includes("--file") ? file(p, bd, queuePath) : { dryRun: true };
  console.log(JSON.stringify({ ...out, plan: p, result }, null, 2));
}

if (import.meta.main) main();
