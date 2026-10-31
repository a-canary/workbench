// sanitize-task — turn ONE MODEL worker-failure queue row into a synthetic harness-bench task (wb-rf4 slice 2).
//
//   bun bin/sanitize-task.ts [--out DIR] '<queue-row-json>'
//
// Row: {id, ts, rule, note} from ~/vault/director/worker-failures/sanitize-queue.jsonl.
// 1. gather the bead description (bd show, in the repo whose .beads mentions the id), its Test: line and a short
//    failure excerpt, with paths stripped;
// 2. ask the local V100 model (laneproxy, `queue` lane, never leaves the box) for a task in the draft schema
//    (~/vault/director/worker-failures/2026-10-31-task-draft.json) with the SAME failure shape, invented domain,
//    plus `reference_solution` (files overlaid on setup_files);
// 3. validate: verify must FAIL on the start state and PASS with the reference applied, each run inside
//    bin/worker-sandbox --exec (no network; there is no unsandboxed mode);
// 4. build the final object, write it to a temp file beside the destination, leak-gate THAT file (fail closed),
//    then rename atomically.
// Accepted -> <out>/<id>.json; rejected -> <out>/rejected/<id>.json with reason (a leak rejection keeps hits only,
// never the task text). Exit 0 accepted, 1 rejected, 2 bad input.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";

export type Row = { id: string; ts?: string; rule: string; note: string };
export type Task = {
  name: string;
  description: string;
  instruction: string;
  setup_files: Record<string, string>;
  reference_solution: Record<string, string>;
  verify: string;
  timeout?: number;
  tags?: string[];
  source?: string;
};
export type Verdict = { accepted: boolean; reason: string; task?: Task; hits?: string[]; latencyMs?: number; path?: string };
export type Deps = {
  callModel: (prompt: string) => Promise<string>;
  sandboxBin?: string; // default bin/worker-sandbox (tests inject a broken one)
  leakArgs?: string[]; // extra leak-gate args (tests pass --denylist)
};

const here = import.meta.dir;
const VAULT = join(homedir(), "vault/director/worker-failures");

// M-rule meanings from 2026-10-31-cases.md (classifier rules)
const SHAPE: Record<string, string> = {
  M1: "the worker ran out of time (or produced no changes) on a task that needs a multi-step change; the task should tempt long exploration while a short targeted edit suffices",
  M2: "the worker left the target tests failing (not green) — the spec has several precise edge cases that are easy to miss",
  M3: "the behavioural tests pass but a strict type/compile check on the file the worker edits FAILS — the obvious implementation is functionally right but does not satisfy the strict checker (e.g. an unnarrowed nullable, an implicit conversion)",
};

const TOOLCHAIN =
  "The verify command runs offline in a jail whose ONLY tools are: python3 (stdlib only — NO mypy, NO pip packages), node and bun (NO tsc, NO npm installs), gcc, sh. " +
  "For a strict type/compile gate use gcc, e.g. first build and run the tests with plain `gcc -std=c11` (NO -Werror, so behaviour is judged separately), then `gcc -std=c11 -Wall -Wextra -Wconversion -Werror -c <impl>.c`. " +
  "verify must start with `cd $BENCH_WORK_DIR && ` and chain the test run AND the strict check with &&.";

/** Replace anything path-like or host-like so no private layout reaches the prompt. */
export function stripPaths(s: string): string {
  return s
    .replace(/(?:~|\.{0,2})?\/?(?:[\w.@-]+\/)+[\w.@-]+/g, "<path>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/[ \t]+/g, " ");
}

function beadRepo(id: string): string | null {
  const repos = join(homedir(), "repos");
  for (const d of readdirSync(repos)) {
    const b = join(repos, d, ".beads");
    if (!existsSync(b)) continue;
    for (const f of readdirSync(b)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        if (readFileSync(join(b, f), "utf8").includes(`"${id}"`)) return join(repos, d);
      } catch {}
    }
  }
  return null;
}

/** Bead description + Test line + failure excerpt, paths stripped and length-capped. */
export function gather(row: Row): { description: string; test: string; excerpt: string } {
  let description = "";
  const repo = beadRepo(row.id);
  if (repo) {
    const r = spawnSync("bd", ["show", row.id, "--json"], { cwd: repo, encoding: "utf8", timeout: 30000 });
    try {
      const j = JSON.parse(r.stdout);
      description = (Array.isArray(j) ? j[0] : j)?.description ?? "";
    } catch {}
  }
  const test = description.match(/^Test:\s*(.+)$/m)?.[1] ?? row.note.match(/GREEN:\s*(.+?)\s+test still fails/)?.[1] ?? "";
  let log = "";
  const logs = join(homedir(), "vault/director/worker-logs");
  if (existsSync(logs)) {
    for (const f of readdirSync(logs)) {
      const t = readFileSync(join(logs, f), "utf8");
      if (t.includes(row.id)) log += t.split("\n").filter((l) => /error|fail|TS\d{4}|timeout/i.test(l)).slice(-8).join("\n");
    }
  }
  return {
    description: stripPaths(description).slice(0, 2500),
    test: stripPaths(test).slice(0, 300),
    excerpt: stripPaths(`${row.note}\n${log}`).slice(0, 800),
  };
}

export function buildPrompt(row: Row, g: ReturnType<typeof gather>, draft: string): string {
  return [
    "You write synthetic coding-benchmark tasks. Below is a REAL task an AI coding worker failed. Write a NEW, small, self-contained task",
    `that reproduces the SAME failure shape: ${SHAPE[row.rule] ?? row.rule}.`,
    "Use a completely invented domain (different nouns, function names, file names). Copy NO code, identifiers, paths, product, company,",
    "person or host names from the real task. Keep it to 2-3 short files.",
    TOOLCHAIN,
    "",
    "Output ONLY one JSON object (no prose, no markdown fence) with keys: name, description, instruction, setup_files (map filename->content: the",
    "START state, with the implementation left as a stub so verify FAILS), reference_solution (map filename->content: the files that, overlaid on",
    "setup_files, make verify PASS — the reference must pass BOTH the tests and the strict check), verify, timeout (ms), tags (array).",
    "The instruction must tell the solver to run both the tests and the strict check. Schema example (a Python variant of this shape):",
    draft,
    "",
    "--- REAL failed task (reference only; do not copy) ---",
    `Test line: ${g.test}`,
    `Description: ${g.description}`,
    `Failure excerpt: ${g.excerpt}`,
  ].join("\n");
}

/** First balanced top-level JSON object in the model text (tolerates <think> blocks and fences). */
export function extractTask(text: string): Task {
  const s = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = s.indexOf("{");
  if (start < 0) throw new Error("no JSON object in model output");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object in model output");
}

function checkShape(t: Task): string | null {
  if (!t || typeof t !== "object") return "task not an object";
  for (const k of ["name", "description", "instruction", "verify"] as const) if (typeof t[k] !== "string" || !t[k]) return `missing ${k}`;
  for (const k of ["setup_files", "reference_solution"] as const) {
    const m = t[k];
    if (!m || typeof m !== "object" || !Object.keys(m).length) return `missing ${k}`;
    for (const [f, c] of Object.entries(m)) {
      if (typeof c !== "string") return `${k}.${f} not a string`;
      const n = normalize(f);
      if (n.startsWith("/") || n.startsWith("..") || n.includes("\0")) return `${k}: unsafe filename`;
    }
  }
  return null;
}

function materialize(dir: string, files: Record<string, string>) {
  for (const [f, c] of Object.entries(files)) {
    const p = join(dir, normalize(f));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c);
  }
}

/** Run verify inside bin/worker-sandbox (no network, only the copy is writable) against a fresh copy of `files`;
 *  returns the exit code (124 = timeout). There is deliberately no unsandboxed path: verify is model-written code. */
export function runVerify(verify: string, files: Record<string, string>, sandboxBin: string): number {
  const dir = mkdtempSync(join(tmpdir(), "sanitize-verify-"));
  materialize(dir, files);
  const r = spawnSync(sandboxBin,
    ["--worktree", dir, "--lane", "private", "--timeout", "60", "--exec", "sh", "-c", `export BENCH_WORK_DIR=/work; ${verify}`],
    { encoding: "utf8", timeout: 90000 });
  return r.status ?? 124;
}

export const RULE_RE = /^[A-Z][0-9]$/;
export const ID_RE = /^[a-z0-9]+-[a-z0-9]+(?:\.[0-9]+)*$/; // bead id: <prefix>-<hash>[.<child>...]
export function rowError(row: Row): string | null {
  if (!row || typeof row !== "object") return "row not an object";
  if (typeof row.id !== "string" || !ID_RE.test(row.id)) return "row.id is not a bead id";
  if (typeof row.rule !== "string" || !RULE_RE.test(row.rule)) return "row.rule is not like M3";
  return null;
}

function reject(out: string, row: Row, body: Record<string, unknown>): string {
  const dir = join(out, "rejected");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${row.id}.json`);
  writeFileSync(p, JSON.stringify({ id: row.id, rule: row.rule, ...body }, null, 2) + "\n");
  return p;
}

/** Model -> final task -> verify FAIL/PASS in the sandbox -> leak-gate the exact bytes -> atomic rename into <out>. */
export async function sanitize(row: Row, deps: Deps, prompt: string, out: string): Promise<Verdict> {
  const bad = rowError(row);
  if (bad) return { accepted: false, reason: bad }; // unsafe id: never used as a filename
  const no = (reason: string, extra: Record<string, unknown> = {}): Verdict => {
    const path = reject(out, row, { reason, ...extra });
    return { accepted: false, reason, path, ...(extra as object) };
  };
  const t0 = Date.now();
  let text: string;
  try { text = await deps.callModel(prompt); } catch (e) { return no(`model call failed: ${(e as Error).message}`); }
  const latencyMs = Date.now() - t0;
  let task: Task;
  try { task = extractTask(text); } catch (e) { return no((e as Error).message, { latencyMs }); }
  const shape = checkShape(task);
  if (shape) return no(`schema: ${shape}`, { latencyMs });
  // build the FINAL object now, so the bytes that are verified and leak-gated are exactly the bytes delivered
  task = { ...task, tags: [...new Set([...(task.tags ?? []), "sweep-derived", "model-failure", row.rule])], source: "worker-failure-sanitizer" };
  const final = JSON.stringify(task, null, 2) + "\n";
  // A broken sandbox cannot yield an accept: the start run's non-zero rc would look like "fails as intended", but the
  // reference run goes through the same sandbox and must exit 0, which a broken sandbox never does.
  const sandboxBin = deps.sandboxBin ?? join(here, "worker-sandbox");
  const startRc = runVerify(task.verify, task.setup_files, sandboxBin);
  if (startRc === 0) return no("verify passes on start state", { latencyMs, task });
  const refRc = runVerify(task.verify, { ...task.setup_files, ...task.reference_solution }, sandboxBin);
  if (refRc !== 0) return no(`verify fails with reference solution (rc ${refRc}; start rc ${startRc})`, { latencyMs, task });
  // leak-gate THE file that ships: temp file in the destination dir, then an atomic rename (same filesystem)
  mkdirSync(out, { recursive: true });
  const tmp = join(out, `.${row.id}.${process.pid}.tmp.json`);
  writeFileSync(tmp, final);
  const r = spawnSync("bun", [join(here, "leak-gate.ts"), ...(deps.leakArgs ?? []), tmp], { encoding: "utf8" });
  if (r.status !== 0) {
    unlinkSync(tmp);
    // hit locations only (leak-gate prints file:line:rule, never content); the task text is not kept
    const hits = (r.stdout + r.stderr).split("\n").filter(Boolean).map((l) => l.replace(tmp, `${row.id}.json`));
    return no("leak-gate", { latencyMs, hits: hits.length ? hits : [`leak-gate exit ${r.status}`] });
  }
  const path = join(out, `${row.id}.json`);
  renameSync(tmp, path);
  return { accepted: true, reason: `start rc ${startRc} (fail), reference rc 0 (pass), leak-gate clean`, task, latencyMs, path };
}

export function laneproxyModel(url = process.env.SANITIZE_LLM_URL ?? "http://127.0.0.1:8099/v1/chat/completions") {
  return async (prompt: string): Promise<string> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "workbench-sanitize-task" },
      body: JSON.stringify({
        model: "queue", // laneproxy lane: latency-tolerant, evictable
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 6000,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(900000),
    });
    if (!res.ok) throw new Error(`laneproxy HTTP ${res.status}`);
    const j = await res.json();
    const c = j?.choices?.[0]?.message?.content;
    if (typeof c !== "string" || !c) throw new Error("empty completion"); // an empty 200 is not a result
    return c;
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let out = join(VAULT, "synth"), rowArg = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else rowArg = args[i];
  }
  let row: Row;
  try { row = JSON.parse(rowArg); } catch { console.error("usage: sanitize-task.ts [--out DIR] '<queue-row-json>'"); process.exit(2); }
  const bad = rowError(row);
  if (bad) { console.error(`sanitize-task: ${bad}`); process.exit(2); }
  const draft = readFileSync(join(VAULT, "2026-10-31-task-draft.json"), "utf8");
  const v = await sanitize(row, { callModel: laneproxyModel() }, buildPrompt(row, gather(row), draft), out);
  console.log(`${v.accepted ? "ACCEPTED" : "REJECTED"} ${row.id}: ${v.reason}${v.hits ? ` [${v.hits.join(", ")}]` : ""} (model ${v.latencyMs ?? "-"}ms) -> ${v.path}`);
  process.exit(v.accepted ? 0 : 1);
}
