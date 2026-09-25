#!/usr/bin/env bun
// skillopt-lite: champion/challenger loop for one agent-spec text artifact.
// Subcommands: mine | split | replay | judge | gate | selftest. No deps beyond bun stdlib.

import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, mkdtempSync, appendFileSync, rmSync, cpSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const PROXY = "http://127.0.0.1:7890/v1/chat/completions";
// override per-run: --base https://api.featherless.ai/v1/chat/completions + SKILLOPT_API_KEY env
const BASE = () => opt("base", PROXY)!;
const KEY = process.env.SKILLOPT_API_KEY;
const CAP = 8000;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, dflt?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const readJsonl = (p: string) =>
  readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const writeJsonl = (p: string, rows: any[]) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};

// --- deterministic PRNG + hash (mulberry32 / fnv1a) ---
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const fnv1a = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};

// --- Wilson 95% lower bound ---
const wilsonLower = (w: number, n: number) => {
  if (n === 0) return 0;
  const z = 1.96, p = w / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
};

// --- shared: seeded shuffle ---
const shuffle = <T>(rows: T[], seed: number) => {
  const r = mulberry32(seed), out = [...rows];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// --- LLM call: single user message, NEVER system (cli/claude/* refuses system role) ---
async function llm(model: string, user: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctl = AbortSignal.timeout(Number(opt("timeout", "120")) * 1000);
      const res = await fetch(BASE(), {
        method: "POST", signal: ctl,
        headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: "user", content: user }] }),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const j: any = await res.json();
      return j.choices[0].message.content;
    } catch (e) {
      if (attempt === 1) throw e;
      console.error(`retrying: ${e}`);
    }
  }
  throw new Error("unreachable");
}

// bounded-concurrency map (concurrency 2)
async function pmap<T, R>(rows: T[], fn: (t: T) => Promise<R>, conc = 2): Promise<R[]> {
  const out: R[] = new Array(rows.length);
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < rows.length) { const k = i++; out[k] = await fn(rows[k]); }
  }));
  return out;
}

// --- mine: scan ~/.claude/projects transcripts for Task/Agent calls to target agent ---
function mine() {
  const agent = opt("agent")!, days = Number(opt("days", "14")), out = opt("out", "dataset.jsonl")!;
  const cutoff = Date.now() - days * 86400_000;
  const root = join(homedir(), ".claude", "projects");
  const rows: any[] = [];
  const tally: Record<string, number> = {};
  for (const proj of readdirSync(root)) {
    let files: string[];
    try { files = readdirSync(join(root, proj)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const p = join(root, proj, f);
      if (statSync(p).mtimeMs < cutoff) continue; // cheap prefilter
      const text = readFileSync(p, "utf8");
      if (!text.includes(agent)) continue;
      const lines = text.split("\n");
      const pending: Record<string, any> = {}; // tool_use_id -> row awaiting result
      for (const line of lines) {
        if (!line) continue;
        const hasCall = line.includes(agent) && line.includes("subagent_type");
        const hasResult = line.includes("tool_result");
        if (!hasCall && !hasResult) continue;
        let d: any; try { d = JSON.parse(line); } catch { continue; }
        const content = d.message?.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (c.type === "tool_use" && c.input?.subagent_type === agent) {
            const ts = d.timestamp || "";
            if (ts && Date.parse(ts) < cutoff) continue;
            const row = {
              id: c.id, session: d.sessionId || f.replace(".jsonl", ""), ts,
              prompt: String(c.input.prompt ?? "").slice(0, CAP), output: null as string | null,
            };
            pending[c.id] = row; rows.push(row);
          } else if (c.type === "tool_result" && pending[c.tool_use_id]) {
            const cc = c.content;
            const text2 = typeof cc === "string" ? cc
              : Array.isArray(cc) ? cc.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n") : "";
            pending[c.tool_use_id].output = text2 ? text2.slice(0, CAP) : null;
            delete pending[c.tool_use_id];
          }
        }
      }
    }
  }
  writeJsonl(out, rows);
  for (const r of rows) { const day = (r.ts || "unknown").slice(0, 10); tally[day] = (tally[day] || 0) + 1; }
  console.error(`mined ${rows.length} rows (${rows.filter((r) => r.output).length} with output) -> ${out}`);
  for (const day of Object.keys(tally).sort()) console.error(`  ${day}: ${tally[day]}`);
}

// --- split: seeded shuffle -> train/test. Test MUST be unbiased random: if the
// driving agent biases test toward "bad" rows, regression-to-mean makes any
// challenger look like an improvement. Only TRAIN may be re-ordered toward bad rows. ---
function split() {
  const inp = opt("in")!, frac = Number(opt("test-frac", "0.5")), seed = Number(opt("seed", "42"));
  const rows = shuffle(readJsonl(inp), seed);
  const nTest = Math.round(rows.length * frac);
  const dir = dirname(inp);
  writeJsonl(join(dir, "test.jsonl"), rows.slice(0, nTest));
  writeJsonl(join(dir, "train.jsonl"), rows.slice(nTest));
  console.error(`split ${rows.length} -> test ${nTest}, train ${rows.length - nTest} (seed ${seed})`);
}

// --- replay: run spec against each test row via proxy ---
async function replay() {
  const spec = readFileSync(opt("spec")!, "utf8");
  const rows = readJsonl(opt("rows")!);
  const model = opt("model", "cli/claude/haiku")!;
  const out = opt("out")!;
  const hermetic = args.includes("--hermetic");
  const conc = Number(opt("concurrency", "2"));
  const results = await pmap(rows, async (r: any) => {
    // spec + row prompt folded into ONE user message (proxy refuses system role).
    // Prefix line is load-bearing: cli-proxy hands the prompt to the CLI as an argv,
    // so a leading "---" (spec frontmatter) parses as a flag and 500s.
    // ponytail: prompt-level guard only; sandbox-enforce the moment any replay is caught
    // writing (guard violated). Chat-only backends are isolated by construction
    // (no tools), but cli/claude/* backends run a real CLI with live tools. If the target
    // agent's rows contain write/mutate instructions, use a chat-only backend or a sandbox.
    let msg = `REPLAY MODE — historical evaluation. You are READ-ONLY: never Write, Edit, run state-changing Bash, or touch databases/ledgers/journals; produce your answer as message text only.\n\nYou are the agent defined by this spec:\n\n${spec}\n\n---\n\nYour task (from the dispatching agent):\n\n${r.prompt}`;
    if (hermetic) {
      // pure-chat backends (featherless etc.) have no file access: inline referenced files
      for (const p of new Set(r.prompt.match(/\/home\/\w+\/\S+\.json\b/g) ?? [])) {
        try { msg += `\n\n---\nContent of ${p} (inlined — you cannot read files; use this):\n${readFileSync(p as string, "utf8").slice(0, 12000)}`; }
        catch { msg += `\n\n---\n${p} is missing.`; }
      }
    }
    try { return { id: r.id, output: (await llm(model, msg)).slice(0, CAP) }; }
    catch (e) { console.error(`row ${r.id} failed: ${e}`); return { id: r.id, output: null }; }
  }, conc);
  writeJsonl(out, results);
  console.error(`replayed ${results.filter((r) => r.output).length}/${rows.length} -> ${out}`);
}

// --- rollout: real sandboxed execution via arc-factory arcsim (docker-heavy).
// run.sh mounts $ARCSIM_RESULTS at /results, so a per-row temp dir IS the exchange dir.
// Contract: <factory>/bench/rollout-one.ts <specFile> <promptFile> <outFile> -> {output, exitCode}.
async function rollout() {
  const spec = readFileSync(opt("spec")!, "utf8");
  // --staged index.jsonl: rows are {id, dir} pre-staged dirs (prompt.txt + input files);
  // each dir is COPIED into the per-row tempdir so arms never mutate the shared staging.
  const staged = opt("staged");
  let rows = staged ? readJsonl(staged) : readJsonl(opt("rows")!);
  const limit = opt("limit"); if (limit) rows = rows.slice(0, Number(limit));
  const out = opt("out")!;
  const factory = opt("factory", join(homedir(), "repos", "arc-factory"))!.replace(/^~/, homedir());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "");
  mkdirSync("/tmp/skillopt-rollout", { recursive: true });
  let done = 0;
  await pmap(rows, async (r: any) => {
    const dir = mkdtempSync("/tmp/skillopt-rollout/row-");
    let output = "";
    try {
      if (staged) {
        cpSync(r.dir, dir, { recursive: true });
        // staged copies keep host perms (e.g. 600 session files) — container uid differs
        Bun.spawnSync(["chmod", "-R", "a+rwX", dir]);
      }
      else writeFileSync(join(dir, "prompt.txt"), String(r.prompt ?? ""));
      writeFileSync(join(dir, "spec.md"), spec);
      const p = Bun.spawnSync(
        ["bash", join(factory, "bench/arcsim/run.sh"), "bun", "bench/rollout-one.ts",
          "/results/spec.md", "/results/prompt.txt", "/results/out.json"],
        { env: { ...process.env, ARCSIM_RESULTS: dir }, stdout: "ignore", stderr: "inherit" });
      // rollout-one exits nonzero on status!=="ok" but still writes a full SolveResult —
      // that failure outcome is judge-relevant, so read out.json before the exit check.
      output = String(JSON.parse(readFileSync(join(dir, "out.json"), "utf8")).output ?? "").slice(0, CAP);
      if (!output && p.exitCode !== 0) throw new Error(`run.sh exit ${p.exitCode}`);
    } catch (e) { console.error(`row ${r.id} failed: ${e}`); }
    appendFileSync(out, JSON.stringify({ id: r.id, output }) + "\n");
    console.error(`rollout ${++done}/${rows.length} ${r.id} ${output ? "ok" : "EMPTY"}`);
    // container-uid-owned files can EACCES host rm — leak the tempdir, don't kill the run
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error(`warn: leak ${dir}: ${e}`); }
  }, Number(opt("concurrency", "1")));
  console.error(`rollout done -> ${out}`);
}

// --- judge: pairwise blind, X/Y randomized per row via seeded id hash ---
export const parseVerdict = (raw: string, aIsX: boolean) => {
  const m = raw.match(/\{[^{}]*"winner"[^{}]*\}/);
  if (!m) return null;
  let j: any; try { j = JSON.parse(m[0]); } catch { return null; }
  const w = j.winner;
  if (w === "tie") return { winner: "tie", why: j.why ?? "" };
  if (w !== "X" && w !== "Y") return null;
  const champWon = (w === "X") === aIsX;
  return { winner: champWon ? "champion" : "challenger", why: j.why ?? "" };
};

async function judge() {
  const rows = readJsonl(opt("rows")!);
  const a = new Map(readJsonl(opt("a")!).map((r: any) => [r.id, r.output])); // champion
  const b = new Map(readJsonl(opt("b")!).map((r: any) => [r.id, r.output])); // challenger
  const model = opt("model", "smart")!, out = opt("out", "verdicts.jsonl")!;
  const verdicts = await pmap(rows, async (r: any) => {
    const oa = a.get(r.id), ob = b.get(r.id);
    if (!oa || !ob) return { id: r.id, winner: "skip", why: "missing output" };
    const aIsX = fnv1a(r.id) % 2 === 0; // randomized but reproducible label assignment
    const [x, y] = aIsX ? [oa, ob] : [ob, oa];
    const msg = `You are judging two AI agent responses to the same task, blind.

TASK GIVEN TO THE AGENT:
${r.prompt}

RESPONSE X:
${x}

RESPONSE Y:
${y}

Judge FIRST on correctness: does the response follow the agent spec's Output contract (strict JSON where required, deliverable actually present)? THEN, only as tiebreak, efficiency (shorter/tighter wins).
Reply with STRICT JSON only, nothing else: {"winner":"X"|"Y"|"tie","why":"<20 words"}`;
    try {
      const v = parseVerdict(await llm(model, msg), aIsX);
      return v ? { id: r.id, aIsX, ...v } : { id: r.id, aIsX, winner: "unparsed", why: "" };
    } catch (e) { return { id: r.id, aIsX, winner: "error", why: String(e).slice(0, 80) }; }
  });
  writeJsonl(out, verdicts);
  const t: Record<string, number> = {};
  for (const v of verdicts) t[v.winner] = (t[v.winner] || 0) + 1;
  console.error(`judged ${verdicts.length} -> ${out} ${JSON.stringify(t)}`);
}

// --- gate ---
function gate() {
  const vs = readJsonl(opt("verdicts")!);
  const w = vs.filter((v: any) => v.winner === "challenger").length;
  const l = vs.filter((v: any) => v.winner === "champion").length;
  const lb = wilsonLower(w, w + l);
  const verdict = lb > 0.5 ? "PROMOTE" : "HOLD";
  console.log(`${verdict} challenger wins=${w} losses=${l} (ties/skips dropped: ${vs.length - w - l}) wilson95lb=${lb.toFixed(3)}`);
}

// --- selftest ---
function selftest() {
  const eq = (got: any, want: any, msg: string) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`FAIL ${msg}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  // Wilson: known values
  if (Math.abs(wilsonLower(8, 10) - 0.49) > 0.01) throw new Error("FAIL wilson 8/10");
  if (Math.abs(wilsonLower(50, 100) - 0.4038) > 0.005) throw new Error("FAIL wilson 50/100");
  eq(wilsonLower(0, 0), 0, "wilson n=0");
  if (!(wilsonLower(20, 22) > 0.5)) throw new Error("FAIL wilson 20/22 should clear 0.5");
  if (wilsonLower(6, 10) > 0.5) throw new Error("FAIL wilson 6/10 should NOT clear 0.5");
  // split determinism
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}` }));
  const s1 = shuffle(rows, 42).map((r) => r.id);
  const s2 = shuffle(rows, 42).map((r) => r.id);
  eq(s1, s2, "shuffle deterministic");
  if (JSON.stringify(shuffle(rows, 43).map((r) => r.id)) === JSON.stringify(s1)) throw new Error("FAIL seed changes shuffle");
  // judge parse
  eq(parseVerdict('{"winner":"X","why":"tighter"}', true), { winner: "champion", why: "tighter" }, "X aIsX=champ");
  eq(parseVerdict('{"winner":"X","why":"w"}', false), { winner: "challenger", why: "w" }, "X !aIsX=chall");
  eq(parseVerdict('junk {"winner":"tie","why":""} trailing', true), { winner: "tie", why: "" }, "tie embedded");
  eq(parseVerdict("no json here", true), null, "garbage -> null");
  eq(parseVerdict('{"winner":"Z","why":""}', true), null, "bad label -> null");
  // opt parsing
  eq(opt("no-such-flag", "dflt"), "dflt", "opt default");
  console.log("selftest OK");
}

const cmds: Record<string, () => any> = { mine, split, replay, rollout, judge, gate, selftest };
if (!cmd || !cmds[cmd]) { console.error("usage: bun skillopt.ts mine|split|replay|rollout|judge|gate|selftest [--flags]"); process.exit(1); }
await cmds[cmd]();
