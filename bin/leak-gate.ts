// leak-gate — deterministic, fail-closed leak scan for sanitized synthetic tasks before they leave this host (wb-rf4).
//
//   bun bin/leak-gate.ts [--denylist F] [--allow-no-gitleaks] <file-or-dir>...
//
// Exit 0 = no hit. Exit 1 = hits, one `file:line:rule  snippet` per line on stdout. Exit 2 = cannot scan (missing/empty
// denylist, gitleaks missing without --allow-no-gitleaks, gitleaks crash, no files, bad args) — fail closed.
// Rules: deny (private names from --denylist, default ~/vault/director/leak-denylist.txt — kept OUT of every repo;
// one term per line, `#` comments, case-insensitive whole-word), ipv4 (except 127.0.0.1, 0.0.0.0, RFC5737 doc
// ranges), tailscale-ip (100.64.0.0/10), email (except example.{com,org,net} and .test/.example/.invalid/.localhost),
// home-path (/home/<user>, /Users/<user>), gitleaks:<RuleID> (bin/gitleaks.toml, host-side). Snippets have every rule
// match redacted; gitleaks hits print no line content at all — matched values are never printed.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type Hit = { file: string; line: number; rule: string; snippet: string };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// whole-word where "word" includes '-' so `pi-lite` does not hit inside `pi-lite-x`, nor `aaron` inside `aaron2`
const wordRe = (terms: string[]) => new RegExp(`(?<![\\w-])(?:${terms.map(esc).join("|")})(?![\\w-])`, "gi");

const IP = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;
const EMAIL = /[\w.+-]+@((?:[\w-]+\.)+[A-Za-z]{2,}|[\w-]+)\b/g;
const HOME = /\/(?:home|Users)\/[A-Za-z0-9._-]+/g;

function ipRule(o: number[]): string | null {
  if (o.some((n) => n > 255)) return null; // not an address (version string etc.)
  const s = o.join(".");
  if (s === "127.0.0.1" || s === "0.0.0.0") return null;
  const [a, b, c] = o;
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return null;
  return a === 100 && b >= 64 && b <= 127 ? "tailscale-ip" : "ipv4";
}
const emailOk = (domain: string) =>
  /(^|\.)example\.(com|org|net)$/i.test(domain) || /(^|\.)(test|example|invalid|localhost)$/i.test(domain);

export function loadDenylist(path: string): string[] | null {
  if (!existsSync(path)) return null;
  const terms = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return terms.length ? terms : null;
}

// regex rules over one file's text; returns hits with match-redacted snippets
export function scanText(file: string, text: string, terms: string[]): Hit[] {
  const deny = wordRe(terms);
  const hits: Hit[] = [];
  text.split("\n").forEach((ln, i) => {
    const found: { rule: string; idx: number; len: number }[] = [];
    for (const m of ln.matchAll(deny)) found.push({ rule: "deny", idx: m.index!, len: m[0].length });
    for (const m of ln.matchAll(IP)) {
      const r = ipRule(m.slice(1, 5).map(Number));
      if (r) found.push({ rule: r, idx: m.index!, len: m[0].length });
    }
    for (const m of ln.matchAll(EMAIL)) if (!emailOk(m[1])) found.push({ rule: "email", idx: m.index!, len: m[0].length });
    for (const m of ln.matchAll(HOME)) found.push({ rule: "home-path", idx: m.index!, len: m[0].length });
    if (!found.length) return;
    let red = ln;
    for (const f of [...found].sort((x, y) => y.idx - x.idx))
      red = red.slice(0, f.idx) + `[${f.rule}]` + red.slice(f.idx + f.len);
    const snippet = red.trim().slice(0, 120);
    for (const rule of new Set(found.map((f) => f.rule))) hits.push({ file, line: i + 1, rule, snippet });
  });
  return hits;
}

function walk(p: string, out: string[]) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) if (e !== ".git") walk(join(p, e), out);
  } else if (st.isFile()) out.push(p);
}

// gitleaks over each input path; Secret/Match fields are never read into output. null = scanner failure.
function gitleaks(paths: string[]): Hit[] | null {
  const cfg = join(dirname(new URL(import.meta.url).pathname), "gitleaks.toml");
  const tmp = mkdtempSync(join(tmpdir(), "leak-gate-"));
  const hits: Hit[] = [];
  paths.forEach((p, n) => {
    const rep = join(tmp, `r${n}.json`);
    const r = spawnSync("gitleaks", ["detect", "--no-git", "-s", p, "--no-banner", "-c", cfg, "-r", rep, "-f", "json", "--exit-code", "0"], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(rep)) throw new Error(`gitleaks failed on ${p} (rc=${r.status})`);
    for (const f of JSON.parse(readFileSync(rep, "utf8") || "[]") as { File: string; StartLine: number; RuleID: string }[])
      hits.push({ file: f.File, line: f.StartLine, rule: `gitleaks:${f.RuleID}`, snippet: "[REDACTED]" });
  });
  return hits;
}

const hasGitleaks = () => {
  try { execFileSync("sh", ["-c", "command -v gitleaks"], { stdio: "ignore" }); return true; } catch { return false; }
};

export function main(argv: string[]): number {
  let denyPath = join(homedir(), "vault/director/leak-denylist.txt");
  let allowNoGitleaks = false;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--denylist") denyPath = argv[++i];
    else if (a === "--allow-no-gitleaks") allowNoGitleaks = true;
    else if (a.startsWith("--")) { console.error(`leak-gate: unknown flag ${a}`); return 2; }
    else paths.push(a);
  }
  if (!paths.length) { console.error("usage: leak-gate [--denylist F] [--allow-no-gitleaks] <file-or-dir>..."); return 2; }
  const terms = denyPath ? loadDenylist(denyPath) : null;
  if (!terms) { console.error(`leak-gate: FAIL CLOSED: denylist missing or empty: ${denyPath}`); return 2; }
  const files: string[] = [];
  try { for (const p of paths) walk(p, files); } catch (e) { console.error(`leak-gate: FAIL CLOSED: ${(e as Error).message}`); return 2; }
  if (!files.length) { console.error("leak-gate: FAIL CLOSED: no files to scan"); return 2; }

  const hits = files.flatMap((f) => scanText(f, readFileSync(f, "utf8"), terms));
  if (hasGitleaks()) {
    try { hits.push(...gitleaks(paths)!); } catch (e) { console.error(`leak-gate: FAIL CLOSED: ${(e as Error).message}`); return 2; }
  } else if (allowNoGitleaks) console.error("leak-gate: WARN: gitleaks not installed; secret scan skipped (--allow-no-gitleaks)");
  else { console.error("leak-gate: FAIL CLOSED: gitleaks not installed (pass --allow-no-gitleaks to skip)"); return 2; }

  for (const h of hits) console.log(`${h.file}:${h.line}:${h.rule}  ${h.snippet}`);
  console.error(`leak-gate: ${files.length} file(s), ${hits.length} hit(s)`);
  return hits.length ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
