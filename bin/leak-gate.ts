// leak-gate — deterministic, fail-closed leak scan for sanitized synthetic tasks before they leave this host (wb-rf4).
//
//   bun bin/leak-gate.ts [--denylist F] [--allow-no-gitleaks] [--budget-ms N] <file-or-dir>...
//
// Exit 0 = no hit. Exit 1 = hits, one `file:line:rule` per line on stdout — NO line content is ever printed (a line
// may also carry a secret). Exit 2 = cannot scan (missing/empty denylist, gitleaks missing without
// --allow-no-gitleaks, gitleaks crash, read error, no files, bad args, text scan over --budget-ms [60000]) — fail closed.
// Rules:
//   deny          private names from --denylist (default ~/vault/director/leak-denylist.txt — kept OUT of every repo;
//                 one term per line, `#` comments). Case-insensitive SUBSTRING match after URL-decoding and dropping
//                 every non-alphanumeric char across the whole file, so slug/camel/snake/dotted/line-split/%-encoded
//                 variants all hit. Over-matching is the intended failure mode. Before squashing, each line is
//                 de-obfuscated (wb-201): HTML entities, JSON \uXXXX, %XX, NFKD + combining-mark strip, and a Cyrillic/
//                 Greek->Latin confusables fold. Reversed text, and base64 (>=12 incl. padding; also at offsets 1-3, and whitespace-
//                 split spans joined) / hex (>=12; also offset 1, `\x` separators dropped) runs decoded, also hit.
//   ipv4          except 127.0.0.1, 0.0.0.0, RFC5737 doc ranges
//   tailscale-ip  100.64.0.0/10 and fd7a:115c:a1e0::/48
//   tailscale-host  *.ts.net
//   email         except example.{com,org,net} and .test/.example/.invalid/.localhost
//   home-path     /home/<user>, /Users/<user>, /root
//   unscannable   not plain UTF-8 text (NUL/control bytes, UTF-16 BOM, gzip or other binary, invalid UTF-8), symlink,
//                 or other non-regular file — never decode-and-hope
//   gitleaks:<RuleID>  bin/gitleaks.toml, host-side
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type Hit = { file: string; line: number; rule: string };

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const IP = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;
const TS6 = /(?<![0-9a-f:])fd7a:115c:a1e0(?![0-9a-f])/i;
// wb-13k: both patterns are linear. TSHOST anchors on the last label char before ".ts.net" (same match set as
// label(.label)*.ts.net). EMAIL bounds the local part to 64 (RFC 5321) so a long run without '@' costs O(64) per start
// instead of O(run); the domain group is unchanged, so every '@' still yields the same domain as before.
const TSHOST = /[a-z0-9-]\.ts\.net\b/i;
const EMAIL = /[\w.+-]{1,64}@((?:[\w-]+\.)+[A-Za-z]{2,}|[\w-]+)\b/g;
const HOME = /\/(?:home|Users)\/[A-Za-z0-9._-]+|\/root(?![\w-])/;

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

// %XX decoded byte-wise; malformed sequences stay as-is
const urlDecode = (s: string) => s.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));

// wb-201 de-obfuscation for the deny rule only. Each step is total (never throws); unknown forms stay as-is.
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const cp = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");
const htmlDecode = (s: string) =>
  s.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]+));/gi, (m, h, d, n) =>
    h ? cp(parseInt(h, 16)) : d ? cp(Number(d)) : (NAMED[n.toLowerCase()] ?? m));
const jsonDecode = (s: string) => s.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
// lowercase Latin lookalikes (Cyrillic, Greek); applied after toLowerCase so capitals fold via their lowercase form
const CONFUSABLE: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x",
  і: "i", ї: "i", ј: "j", ѕ: "s", һ: "h", ԁ: "d", ԛ: "q", ԝ: "w", ӏ: "l",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", μ: "u", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ζ: "z",
};
const fold = (s: string) =>
  [...urlDecode(jsonDecode(htmlDecode(s))).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()]
    .map((c) => CONFUSABLE[c] ?? c).join("");
// decoded payloads of plausible base64 / hex runs in one line, folded + squashed. Each run is also decoded at
// offsets 1-3 (base64) / 1 (hex) so a short glued prefix cannot misalign it; `\x` separators are dropped first.
const B64 = /[A-Za-z0-9+/_-]{10,}={0,2}/g; // kept only when >=12 chars incl. padding
const HEX = /[0-9a-f]{12,}/gi;
const b64Variants = (run: string, out: string[]) => {
  for (let o = 0; o < 4 && run.length - o >= 12; o++) out.push(squash(fold(Buffer.from(run.slice(o), "base64").toString("utf8"))));
};
function decodedRuns(ln: string): string[] {
  const out: string[] = [];
  for (const m of ln.replace(/\\x/gi, "").matchAll(HEX))
    for (const o of [0, 1]) out.push(squash(fold(Buffer.from(m[0].slice(o), "hex").toString("latin1"))));
  for (const m of ln.matchAll(B64)) b64Variants(m[0], out);
  return out;
}
// base64 wrapped or split by whitespace/newlines: whitespace-joined spans of base64 chars, whitespace stripped, decoded
// at offsets 0-3. Reported at the span's first line. The lookbehind starts spans only at run starts (linear).
const B64_SPAN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]+(?:\s+[A-Za-z0-9+/_-]+)+={0,2}/g;

export function loadDenylist(path: string): string[] | null {
  if (!existsSync(path)) return null;
  const terms = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map(squash).filter(Boolean);
  return terms.length ? terms : null;
}

// plain UTF-8 text or null. Allowed controls: \t \n \f \r; a UTF-8 BOM is tolerated.
export function asText(buf: Buffer): string | null {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return null;
  for (const b of buf) if ((b < 0x20 && b !== 9 && b !== 10 && b !== 12 && b !== 13) || b === 0x7f) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return null; }
}

// all text rules over one file; terms are pre-squashed (loadDenylist)
// deadline (performance.now() ms): past it the scan throws, and main fails closed (wb-13k)
export function scanText(file: string, text: string, terms: string[], deadline = Infinity): Hit[] {
  const tick = () => { if (performance.now() >= deadline) throw new Error(`scan time budget exceeded on ${file}`); };
  const seen = new Set<string>();
  const hits: Hit[] = [];
  const add = (line: number, rule: string) => {
    const k = `${line}:${rule}`;
    if (!seen.has(k)) { seen.add(k); hits.push({ file, line, rule }); }
  };
  const lines = text.split("\n");
  // deny: whole file squashed to [a-z0-9] with a char->line map, so terms split across lines still hit
  let flat = "";
  const lineOf: number[] = [];
  lines.forEach((ln, i) => {
    tick();
    for (const ch of fold(ln)) if (/[a-z0-9]/.test(ch)) { flat += ch; lineOf.push(i + 1); }
  });
  for (const t of terms) {
    tick();
    for (let at = flat.indexOf(t); at >= 0; at = flat.indexOf(t, at + 1)) add(lineOf[at], "deny");
    const r = [...t].reverse().join(""); // reversed text == reversed term in forward text
    for (let at = flat.indexOf(r); at >= 0; at = flat.indexOf(r, at + 1)) add(lineOf[at], "deny");
  }
  lines.forEach((ln, i) => {
    tick();
    for (const d of decodedRuns(ln)) if (terms.some((t) => d.includes(t))) add(i + 1, "deny");
  });
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  for (const m of text.matchAll(B64_SPAN)) {
    tick();
    const ds: string[] = [];
    b64Variants(m[0].replace(/\s+/g, ""), ds);
    if (ds.some((d) => terms.some((t) => d.includes(t)))) {
      let lo = 0;
      for (let hi = lineStarts.length - 1; lo < hi;) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= m.index!) lo = mid; else hi = mid - 1; }
      add(lo + 1, "deny");
    }
  }
  lines.forEach((raw, i) => {
    tick();
    for (const ln of new Set([raw, urlDecode(raw)])) {
      for (const m of ln.matchAll(IP)) { const r = ipRule(m.slice(1, 5).map(Number)); if (r) add(i + 1, r); }
      if (TS6.test(ln)) add(i + 1, "tailscale-ip");
      if (TSHOST.test(ln)) add(i + 1, "tailscale-host");
      for (const m of ln.matchAll(EMAIL)) if (!emailOk(m[1])) add(i + 1, "email");
      if (HOME.test(ln)) add(i + 1, "home-path");
    }
  });
  return hits.sort((a, b) => a.line - b.line);
}

// regular files -> out; symlinks / sockets / devices -> unscannable hits (never followed)
function walk(p: string, out: string[], bad: Hit[]) {
  const st = lstatSync(p);
  if (st.isDirectory()) { for (const e of readdirSync(p)) if (e !== ".git") walk(join(p, e), out, bad); }
  else if (st.isFile()) out.push(p);
  else bad.push({ file: p, line: 1, rule: "unscannable" });
}

// gitleaks over each input path; Secret/Match fields are never read into output. Throws on scanner failure.
function gitleaks(paths: string[]): Hit[] {
  const cfg = join(dirname(new URL(import.meta.url).pathname), "gitleaks.toml");
  const tmp = mkdtempSync(join(tmpdir(), "leak-gate-"));
  const hits: Hit[] = [];
  paths.forEach((p, n) => {
    const rep = join(tmp, `r${n}.json`);
    const r = spawnSync("gitleaks", ["detect", "--no-git", "-s", p, "--no-banner", "-c", cfg, "-r", rep, "-f", "json", "--exit-code", "0"], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(rep)) throw new Error(`gitleaks failed on ${p} (rc=${r.status})`);
    for (const f of JSON.parse(readFileSync(rep, "utf8") || "[]") as { File: string; StartLine: number; RuleID: string }[])
      hits.push({ file: f.File, line: f.StartLine, rule: `gitleaks:${f.RuleID}` });
  });
  return hits;
}

const hasGitleaks = () => {
  try { execFileSync("sh", ["-c", "command -v gitleaks"], { stdio: "ignore" }); return true; } catch { return false; }
};

export function main(argv: string[]): number {
  let denyPath = join(homedir(), "vault/director/leak-denylist.txt");
  let allowNoGitleaks = false;
  let budgetMs = 60_000; // whole text scan; past it -> exit 2 (a stalled scan must never read as a pass)
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--denylist") denyPath = argv[++i];
    else if (a === "--allow-no-gitleaks") allowNoGitleaks = true;
    else if (a === "--budget-ms") { budgetMs = Number(argv[++i]); if (!(budgetMs >= 0)) { console.error("leak-gate: bad --budget-ms"); return 2; } }
    else if (a.startsWith("--")) { console.error(`leak-gate: unknown flag ${a}`); return 2; }
    else paths.push(a);
  }
  if (!paths.length) { console.error("usage: leak-gate [--denylist F] [--allow-no-gitleaks] [--budget-ms N] <file-or-dir>..."); return 2; }
  const fail = (msg: string) => { console.error(`leak-gate: FAIL CLOSED: ${msg}`); return 2; };
  const terms = denyPath ? loadDenylist(denyPath) : null;
  if (!terms) return fail(`denylist missing or empty: ${denyPath}`);

  const files: string[] = [];
  const hits: Hit[] = [];
  const deadline = performance.now() + budgetMs;
  try {
    for (const p of paths) walk(p, files, hits);
    for (const f of files) {
      const text = asText(readFileSync(f));
      if (text === null) hits.push({ file: f, line: 1, rule: "unscannable" });
      else hits.push(...scanText(f, text, terms, deadline));
    }
  } catch (e) { return fail((e as Error).message); }
  if (!files.length && !hits.length) return fail("no files to scan");

  if (hasGitleaks()) {
    try { hits.push(...gitleaks(paths)); } catch (e) { return fail((e as Error).message); }
  } else if (allowNoGitleaks) console.error("leak-gate: WARN: gitleaks not installed; secret scan skipped (--allow-no-gitleaks)");
  else return fail("gitleaks not installed (pass --allow-no-gitleaks to skip)");

  for (const h of hits) console.log(`${h.file}:${h.line}:${h.rule}`);
  console.error(`leak-gate: ${files.length} file(s), ${hits.length} hit(s)`);
  return hits.length ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
