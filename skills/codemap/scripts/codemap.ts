#!/usr/bin/env -S npx tsx
/**
 * codemap — deterministic codebase snapshot → PlantUML + report.
 *
 * Zero LLM. Zero hard deps (Node builtins only; uses `git` and `rg` if present).
 * Stages: detect → inventory → graph → signals → render.
 *
 * Usage:
 *   npx tsx codemap.ts [projectDir]      # no flags — one fast, opinionated pass
 *
 * Emits into <projectDir>/codemap (git-tracked — commit it):
 *   codemap.puml      PlantUML component diagram (modules = import communities)
 *   codemap.md        Snapshot report with YAML frontmatter
 *   codemap.json      Raw graph IR
 *
 * Progress tracking is built in: commit codemap.json, change code, re-run; the
 * delta vs the committed snapshot is written every run. No flags, no knobs.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------- types ----------
type Kind = "source" | "test" | "config" | "doc" | "output" | "other";
interface FileRec {
  rel: string;
  kind: Kind;
  loc: number;
  lang: string;
  imports: string[]; // resolved rel paths (local only)
  externals: string[]; // bare specifiers
  exports: string[]; // exported symbol names (best-effort)
  shebang?: boolean;
  frontmatter?: Record<string, unknown>;
}
interface Graph {
  root: string;
  ecosystems: string[];
  files: Record<string, FileRec>;
  entrypoints: string[];
  graphSource: "madge" | "regex";
}

// ---------- args ----------
// No flags by design: one opinionated pass. The only argument is an optional
// target directory (defaults to cwd); output always lands in <target>/codemap.
const root = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) || ".");
const outDir = path.join(root, "codemap");

const log = (m: string) => process.stderr.write(`[codemap] ${m}\n`);

// ---------- helpers ----------
function sh(cmd: string, cmdArgs: string[]): string | null {
  try {
    return execFileSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}
const exists = (p: string) => fs.existsSync(path.join(root, p));

const SRC_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"];
const langOf = (rel: string): string => {
  const e = path.extname(rel);
  return { ".ts": "ts", ".tsx": "ts", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".py": "py", ".go": "go", ".rs": "rs" }[e] || e.slice(1) || "?";
};
const isTest = (rel: string) =>
  /(^|\/)(test|tests|__tests__|spec|e2e)(\/|$)/i.test(rel) || /\.(test|spec)\.[a-z]+$/i.test(rel) || /_test\.(py|go)$/i.test(rel);
const isOutput = (rel: string) =>
  /(^|\/)(dist|build|out|coverage|logs?|\.next|\.turbo|__pycache__|target)(\/|$)/i.test(rel) || /\.(log|lcov|map)$/i.test(rel);
const CONFIG_NAMES =
  /(^|\/)(package\.json|tsconfig.*\.json|pyproject\.toml|setup\.cfg|setup\.py|requirements.*\.txt|Cargo\.toml|go\.mod|\.eslintrc.*|eslint\.config\.[jt]s|biome\.jsonc?|\.prettierrc.*|vite\.config\.[jt]s|vitest\.config\.[jt]s|jest\.config\.[jt]s|\.env(\..+)?|Dockerfile|docker-compose\.ya?ml|Makefile|\.gitignore)$/i;

function kindOf(rel: string): Kind {
  if (isOutput(rel)) return "output";
  if (CONFIG_NAMES.test(rel) || /^\.github\/.*\.ya?ml$/i.test(rel)) return "config";
  if (rel.endsWith(".md") || rel.endsWith(".mdx")) return "doc";
  if (SRC_EXT.includes(path.extname(rel))) return isTest(rel) ? "test" : "source";
  return "other";
}

// ---------- stage 1: detect ----------
function detect(): string[] {
  const eco: string[] = [];
  if (exists("package.json")) eco.push("node");
  if (exists("tsconfig.json")) eco.push("typescript");
  if (exists("pyproject.toml") || exists("setup.py") || exists("requirements.txt")) eco.push("python");
  if (exists("go.mod")) eco.push("go");
  if (exists("Cargo.toml")) eco.push("rust");
  return eco.length ? eco : ["unknown"];
}

// ---------- stage 2: inventory ----------
function listFiles(): string[] {
  // Exclude codemaps own output dir so the map never inventories itself (churn-on-every-run).
  const outRel = path.relative(root, outDir);
  const isOwn = (rel: string) => rel === outRel || rel.startsWith(outRel + "/");
  const tracked = sh("git", ["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (tracked) return tracked.split("\n").filter(Boolean).filter((r) => !isOwn(r));
  // fallback walk
  const out: string[] = [];
  const skip = /(^|\/)(node_modules|\.git|dist|build|coverage|__pycache__|\.venv|venv|target|\.next)(\/|$)/;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (skip.test(rel)) continue;
      if (e.isDirectory()) walk(full);
      else out.push(rel);
    }
  };
  walk(root);
  return out.filter((r) => !isOwn(r));
}

function parseFrontmatter(text: string): Record<string, unknown> | undefined {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return undefined;
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return Object.keys(fm).length ? fm : undefined;
}

// import extractors
const IMPORT_RE = [
  /\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+[^'"]*?\s+from\s+["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];
const PY_IMPORT_RE = [/^\s*from\s+([.\w]+)\s+import\b/gm, /^\s*import\s+([.\w]+)/gm];
const EXPORT_RE = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g,
  /\bexport\s*\{\s*([^}]+)\}/g,
];

function resolveFile(target: string, allFiles: Set<string>): string | null {
  const t = target.replace(/\\/g, "/").replace(/\/+$/, "");
  const cands = [
    t,
    ...SRC_EXT.map((e) => t + e),
    // .js specifier in TS source → resolve to .ts
    ...(t.endsWith(".js") ? [t.replace(/\.js$/, ".ts"), t.replace(/\.js$/, ".tsx")] : []),
    ...["index.ts", "index.tsx", "index.js", "index.jsx", "__init__.py"].map((e) => `${t}/${e}`),
  ];
  for (const c of cands) if (allFiles.has(c)) return c;
  return null;
}

function resolveLocal(fromRel: string, spec: string, allFiles: Set<string>): string | null {
  if (!spec.startsWith(".")) return null; // external / bare / alias
  const baseDir = path.dirname(fromRel);
  return resolveFile(path.normalize(path.join(baseDir, spec)).replace(/\\/g, "/"), allFiles);
}

// strip JSONC (comments + trailing commas) so tsconfig.json parses
const stripJsonc = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");

// Resolve bare specifiers that actually point inside this repo: workspace package
// names (monorepo `@scope/pkg` → `packages/pkg`) and tsconfig `paths` aliases
// (`@/x` → `src/x`). Without this, every cross-package import is mis-counted as an
// external dep and inter-package seams vanish from the map.
type AliasResolver = (spec: string) => string | null;
function buildAliases(allRel: string[], set: Set<string>): AliasResolver[] {
  const resolvers: AliasResolver[] = [];
  // 1. workspace packages — name from each package.json → its dir + entry file
  for (const rel of allRel) {
    if (!/(^|\/)package\.json$/.test(rel)) continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    } catch {
      continue;
    }
    const name = pkg.name;
    if (typeof name !== "string" || !name) continue;
    const d = path.dirname(rel);
    const dir = d === "." ? "" : d;
    const exp = pkg.exports;
    const expMain =
      typeof exp === "string" ? exp : exp && typeof exp === "object" ? JSON.stringify(exp).match(/\.\/[^"']+/)?.[0] : undefined;
    const entryCands = [pkg.module, pkg.main, expMain].filter((x): x is string => typeof x === "string").map((x) => x.replace(/^\.\//, ""));
    const pre = (p: string) => (dir ? `${dir}/${p}` : p);
    let entry: string | null = null;
    for (const e of [...entryCands, "src/index", "index", "src/main", "main"]) {
      entry = resolveFile(pre(e), set);
      if (entry) break;
    }
    resolvers.push((spec) => {
      if (spec === name) return entry;
      if (spec.startsWith(`${name}/`)) {
        const sub = spec.slice(name.length + 1);
        return resolveFile(pre(sub), set) ?? resolveFile(pre(`src/${sub}`), set);
      }
      return null;
    });
  }
  // 2. tsconfig path aliases (root configs — covers the common `@/*` case)
  for (const tc of ["tsconfig.json", "tsconfig.base.json"]) {
    let cfg: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    try {
      cfg = JSON.parse(stripJsonc(fs.readFileSync(path.join(root, tc), "utf8")));
    } catch {
      continue;
    }
    const paths = cfg.compilerOptions?.paths;
    if (!paths) continue;
    const baseUrl = (cfg.compilerOptions?.baseUrl ?? ".").replace(/^\.\/?/, "");
    const pre = (p: string) => (baseUrl ? `${baseUrl}/${p}` : p);
    for (const [pat, tgts] of Object.entries(paths)) {
      if (!Array.isArray(tgts)) continue;
      const targets = tgts.map((t) => t.replace(/^\.\//, ""));
      const star = pat.includes("*");
      const prefix = pat.replace(/\*.*$/, "");
      resolvers.push((spec) => {
        if (star) {
          if (!spec.startsWith(prefix)) return null;
          const rest = spec.slice(prefix.length);
          for (const t of targets) {
            const r = resolveFile(pre(t.replace("*", rest)), set);
            if (r) return r;
          }
        } else if (spec === pat) {
          for (const t of targets) {
            const r = resolveFile(pre(t), set);
            if (r) return r;
          }
        }
        return null;
      });
    }
  }
  return resolvers;
}

// ---------- graph source: prefer madge (AST) over regex when available ----------
// The regex extractor reads import-like text inside comments and strings as real
// edges (e.g. a JSDoc usage example `import { x } from 'pkg'`), which fabricates
// edges and therefore phantom cycles. madge resolves the graph from the AST + the
// tsconfig, so it never sees commented/quoted imports. Use it when installed.
function madgeAvailable(): boolean {
  try {
    execFileSync("madge", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/** AST-accurate JS/TS import graph via madge. Returns rel→[rel] edges (root-relative,
 *  git-tracked only), or null on any failure / no JS-TS files. madge reports paths
 *  relative to the common ancestor of its args, so every path is re-resolved against
 *  candidate prefixes back to a tracked root-relative file. */
function madgeGraph(allRel: string[], set: Set<string>): Record<string, string[]> | null {
  const jsts = allRel.filter(
    (r) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(r) && !r.endsWith(".d.ts"),
  );
  if (!jsts.length) return null;
  // entry args = distinct top-level dirs + any root-level files. Keeps madge off
  // node_modules and forces the common-ancestor base to the repo root on multi-dir repos.
  const entries = [...new Set(jsts.map((r) => (r.includes("/") ? r.split("/")[0] : r)))];
  const tscfg = ["tsconfig.json", "tsconfig.base.json"].find((t) => fs.existsSync(path.join(root, t)));
  const args = ["--json", "--extensions", "ts,tsx,js,jsx,mjs,cjs", ...(tscfg ? ["--ts-config", tscfg] : []), ...entries];
  let raw = "";
  try {
    raw = execFileSync("madge", args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e: any) {
    raw = e?.stdout?.toString() ?? "";
  }
  let graph: Record<string, string[]>;
  try {
    graph = JSON.parse(raw || "{}");
  } catch {
    return null;
  }
  const canon = (p: string): string | null => {
    if (set.has(p)) return p;
    for (const d of entries) {
      const c = path.normalize(path.join(d, p)).replace(/\\/g, "/");
      if (set.has(c)) return c;
    }
    return null;
  };
  const out: Record<string, string[]> = {};
  for (const [k, deps] of Object.entries(graph)) {
    const kk = canon(k);
    if (!kk) continue;
    const resolved: string[] = [];
    for (const d of deps as string[]) {
      const dd = canon(d);
      if (dd && dd !== kk && !resolved.includes(dd)) resolved.push(dd);
    }
    out[kk] = resolved;
  }
  return Object.keys(out).length ? out : null;
}

function inventory(allRel: string[]): Record<string, FileRec> {
  const set = new Set(allRel);
  const aliases = buildAliases(allRel, set);
  const recs: Record<string, FileRec> = {};
  for (const rel of allRel) {
    const kind = kindOf(rel);
    const lang = langOf(rel);
    let text = "";
    try {
      const st = fs.statSync(path.join(root, rel));
      if (st.size > 2 * 1024 * 1024) {
        recs[rel] = { rel, kind, loc: 0, lang, imports: [], externals: [], exports: [] };
        continue;
      }
      text = fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    const loc = text ? text.split("\n").length : 0;
    const rec: FileRec = { rel, kind, loc, lang, imports: [], externals: [], exports: [] };
    if (kind === "doc") rec.frontmatter = parseFrontmatter(text);
    if (kind === "source" || kind === "test") {
      if (text.startsWith("#!")) rec.shebang = true;
      const res = lang === "py" ? PY_IMPORT_RE : IMPORT_RE;
      const specs = new Set<string>();
      for (const re of res) {
        re.lastIndex = 0;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(text))) specs.add(mm[1]);
      }
      for (const s of specs) {
        const local = lang === "py" ? null : resolveLocal(rel, s, set);
        if (local) {
          rec.imports.push(local);
          continue;
        }
        if (s.startsWith(".")) continue;
        let aliased: string | null = null;
        if (lang !== "py") for (const a of aliases) if ((aliased = a(s))) break;
        if (aliased) rec.imports.push(aliased);
        else rec.externals.push(s.split("/").slice(0, s.startsWith("@") ? 2 : 1).join("/"));
      }
      // names re-exported from elsewhere aren't *defined* here — exclude them so
      // barrels/re-exports don't inflate the redundancy signal
      const reExported = new Set<string>();
      const REEXPORT_RE = /\bexport\s*\{\s*([^}]+)\}\s*from\s*["'][^"']+["']/g;
      let rx: RegExpExecArray | null;
      while ((rx = REEXPORT_RE.exec(text))) for (const nm of rx[1].split(",")) reExported.add(nm.trim().split(/\s+as\s+/)[0].trim());
      for (const re of EXPORT_RE) {
        re.lastIndex = 0;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(text))) {
          for (const nm of mm[1].split(",")) {
            const clean = nm.trim().split(/\s+as\s+/)[0].trim();
            if (clean && /^[A-Za-z0-9_$]+$/.test(clean) && !reExported.has(clean)) rec.exports.push(clean);
          }
        }
      }
    }
    recs[rel] = rec;
  }
  return recs;
}

// ---------- stage 1.5: entrypoints ----------
function findEntrypoints(files: Record<string, FileRec>): string[] {
  const eps = new Set<string>();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const add = (v: unknown) => {
      if (typeof v === "string") {
        const norm = v.replace(/^\.\//, "");
        if (files[norm]) eps.add(norm);
      }
    };
    add(pkg.main);
    add(pkg.module);
    if (pkg.bin) Object.values(pkg.bin).forEach(add);
    if (pkg.exports) JSON.stringify(pkg.exports).match(/\.\/[^"']+/g)?.forEach((s) => add(s.replace(/^\.\//, "")));
  } catch {
    /* no pkg */
  }
  for (const rel of Object.keys(files)) {
    if (/(^|\/)(index|main|cli|server|app|__main__)\.[a-z]+$/i.test(rel)) eps.add(rel);
    // standalone runnable files are roots, not dead library code
    if (/(^|\/)(benchmarks?|examples?|demos?|prototypes?|fixtures?|__mocks__|mocks?|stories|e2e|scripts?|bin)(\/|$)/i.test(rel)) eps.add(rel);
    // generated code isn't hand-maintained library code — exempt from dead/untested bars
    if (/\.(generated|gen)\.[a-z]+$/i.test(rel) || /(^|\/)(generated|__generated__)\//i.test(rel)) eps.add(rel);
    if (files[rel].kind === "test") eps.add(rel);
    if (files[rel].shebang) eps.add(rel);
  }
  return [...eps];
}

// ---------- stage 4: signals ----------
function deadCode(g: Graph): string[] {
  const inbound = new Map<string, number>();
  for (const f of Object.values(g.files)) for (const imp of f.imports) inbound.set(imp, (inbound.get(imp) || 0) + 1);
  const ep = new Set(g.entrypoints);
  // dead = an importable unit (has exports) that no one imports and isn't an entrypoint.
  // files with no exports + no inbound are standalone scripts, not dead library code.
  return Object.values(g.files)
    .filter((f) => f.kind === "source" && !ep.has(f.rel) && f.exports.length > 0 && !((inbound.get(f.rel) || 0) > 0))
    .map((f) => f.rel)
    .sort();
}

function cycles(g: Graph): string[][] {
  // Tarjan SCC over import edges; report SCCs of size>1
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const sccs: string[][] = [];
  const nodes = Object.keys(g.files);
  const strongconnect = (v: string) => {
    idx.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of g.files[v]?.imports || []) {
      if (!g.files[w]) continue;
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp.sort());
    }
  };
  for (const v of nodes) if (!idx.has(v)) strongconnect(v);
  return sccs;
}

function untested(g: Graph): string[] {
  const testedBy = new Set<string>();
  for (const f of Object.values(g.files)) if (f.kind === "test") for (const imp of f.imports) testedBy.add(imp);
  const bases = new Set(
    Object.values(g.files)
      .filter((f) => f.kind === "test")
      .map((f) => path.basename(f.rel).replace(/\.(test|spec)\./, ".").replace(/_test\./, ".")),
  );
  const ep = new Set(g.entrypoints);
  // untested = importable unit (has exports) no test imports and no sibling test covers.
  return Object.values(g.files)
    .filter((f) => f.kind === "source" && f.exports.length > 0 && !ep.has(f.rel) && !testedBy.has(f.rel) && !bases.has(path.basename(f.rel)))
    .map((f) => f.rel)
    .sort();
}

function redundancy(g: Graph): { sameBasename: Record<string, string[]>; sameExport: Record<string, string[]> } {
  const byBase: Record<string, string[]> = {};
  const byExport: Record<string, string[]> = {};
  for (const f of Object.values(g.files)) {
    if (f.kind !== "source") continue;
    const b = path.basename(f.rel);
    (byBase[b] ||= []).push(f.rel);
    for (const ex of new Set(f.exports)) (byExport[ex] ||= []).push(f.rel);
  }
  const filt = (o: Record<string, string[]>) => Object.fromEntries(Object.entries(o).filter(([, v]) => new Set(v).size > 1));
  // structural filenames that legitimately recur once per module/package — low signal
  const noisyBase = new Set(["index.ts", "index.tsx", "index.js", "types.ts", "types.tsx", "store.ts", "routes.ts", "schema.ts", "constants.ts", "config.ts", "main.ts"]);
  // generic symbol names whose collision is usually coincidence, not duplication
  const noisyExport = new Set(["index", "default", "handler", "main", "Props", "Config", "Options", "State", "Result", "Params", "Metadata", "Schema", "Type", "Data", "Context", "Provider"]);
  const sameBasename = Object.fromEntries(Object.entries(filt(byBase)).filter(([k]) => !noisyBase.has(k)));
  const sameExport = Object.fromEntries(Object.entries(filt(byExport)).filter(([k]) => !noisyExport.has(k) && k.length > 3));
  return { sameBasename, sameExport };
}

// ---------- module aggregation ----------
// Directory grouping: top-level dir, or src/<x> | lib/<x> | app/<x> | packages/<x>
// one level deep. This is the fallback when there is no import graph to cluster.
function dirModuleOf(rel: string): string {
  const parts = rel.split("/");
  if (parts.length === 1) return ".";
  if (["src", "lib", "app", "apps", "packages"].includes(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

// When clustering is active, MODULE_MAP holds rel→community-label for every source
// file that has a graph edge; everything else falls back to its directory. moduleOf
// is the single chokepoint all rendering/diff goes through, so flipping the grouping
// mode only touches this map — no caller changes.
let MODULE_MAP: Map<string, string> | null = null;
function moduleOf(rel: string): string {
  return MODULE_MAP?.get(rel) ?? dirModuleOf(rel);
}

/** Louvain community detection over an undirected weighted graph. Deterministic:
 *  nodes processed in sorted order, ties broken by id, no randomness.
 *  adj: symmetric Map<node, Map<neighbour, weight>>; returns Map<node, communityInt>. */
function louvain(adj: Map<string, Map<string, number>>): Map<string, number> {
  const nodes = [...adj.keys()].sort();
  const idOf = new Map(nodes.map((n, i) => [n, i]));
  let N = nodes.length;
  let W = nodes.map((n) => {
    const m = new Map<number, number>();
    for (const [nb, w] of adj.get(n)!) if (nb !== n) m.set(idOf.get(nb)!, w);
    return m;
  });
  let self = nodes.map((n) => adj.get(n)!.get(n) || 0);
  let members: string[][] = nodes.map((n) => [n]);
  const buildDeg = (W: Map<number, number>[], self: number[]) =>
    W.map((m, i) => [...m.values()].reduce((a, b) => a + b, 0) + 2 * self[i]);
  while (true) {
    const deg = buildDeg(W, self);
    const twoM = deg.reduce((a, b) => a + b, 0);
    if (twoM === 0) break;
    const comm = W.map((_, i) => i);
    const commTot = deg.slice();
    let improvedAny = false;
    let moved = true;
    let guard = 0;
    while (moved && guard++ < 100) {
      moved = false;
      for (let i = 0; i < N; i++) {
        const ci = comm[i];
        const wTo = new Map<number, number>();
        for (const [j, w] of W[i]) { const cj = comm[j]; wTo.set(cj, (wTo.get(cj) || 0) + w); }
        commTot[ci] -= deg[i];
        const wToCi = wTo.get(ci) || 0;
        let best = ci;
        let bestGain = wToCi - (commTot[ci] * deg[i]) / twoM;
        for (const c of [...wTo.keys()].sort((a, b) => a - b)) {
          if (c === ci) continue;
          const gain = wTo.get(c)! - (commTot[c] * deg[i]) / twoM;
          if (gain > bestGain + 1e-12) { bestGain = gain; best = c; }
        }
        commTot[best] += deg[i];
        if (best !== ci) { comm[i] = best; moved = true; improvedAny = true; }
      }
    }
    const uniq = [...new Set(comm)].sort((a, b) => a - b);
    const reId = new Map(uniq.map((c, k) => [c, k]));
    const newN = uniq.length;
    if (newN === N) break;
    const nW: Map<number, number>[] = Array.from({ length: newN }, () => new Map());
    const nSelf = new Array(newN).fill(0);
    const nMembers: string[][] = Array.from({ length: newN }, () => []);
    for (let i = 0; i < N; i++) {
      const ci = reId.get(comm[i])!;
      nMembers[ci].push(...members[i]);
      nSelf[ci] += self[i];
    }
    for (let i = 0; i < N; i++) {
      const ci = reId.get(comm[i])!;
      for (const [j, w] of W[i]) {
        if (j < i) continue;
        const cj = reId.get(comm[j])!;
        if (ci === cj) nSelf[ci] += w;
        else { nW[ci].set(cj, (nW[ci].get(cj) || 0) + w); nW[cj].set(ci, (nW[cj].get(ci) || 0) + w); }
      }
    }
    W = nW; self = nSelf; members = nMembers; N = newN;
    if (!improvedAny) break;
  }
  const out = new Map<string, number>();
  for (let c = 0; c < members.length; c++) for (const orig of members[c]) out.set(orig, c);
  return out;
}

/** Newman modularity Q of a partition over an undirected weighted graph (no self-loops). */
function modularityOf(adj: Map<string, Map<string, number>>, comm: Map<string, number>): number {
  let twoM = 0;
  for (const nb of adj.values()) for (const w of nb.values()) twoM += w;
  if (twoM === 0) return 0;
  let intra = 0;
  const kc = new Map<number, number>();
  for (const [a, nb] of adj) {
    const ca = comm.get(a)!;
    let k = 0;
    for (const [b, w] of nb) { k += w; if (comm.get(b) === ca) intra += w; }
    kc.set(ca, (kc.get(ca) || 0) + k);
  }
  let sub = 0;
  for (const k of kc.values()) sub += k * k;
  return (intra - sub / twoM) / twoM;
}

/** Group source files into modules by import community instead of by directory.
 *  Builds an undirected weighted graph over source files (directed imports folded,
 *  weights summed), runs Louvain, then names each community by the plurality
 *  directory among its members (collisions disambiguated by the hub file). Returns
 *  rel→label for every clustered source file; edgeless files are omitted so the
 *  caller's moduleOf falls back to their directory. Empty map = nothing to cluster. */
function clusterModules(g: Graph): Map<string, string> {
  const adj = new Map<string, Map<string, number>>();
  const isSrc = (r: string) => g.files[r] && g.files[r].kind === "source";
  const bump = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Map());
    const m = adj.get(a)!;
    m.set(b, (m.get(b) || 0) + 1);
  };
  for (const f of Object.values(g.files)) {
    if (f.kind !== "source") continue;
    for (const imp of f.imports) {
      if (imp === f.rel || !isSrc(imp)) continue;
      bump(f.rel, imp);
      bump(imp, f.rel);
    }
  }
  if (!adj.size) return new Map();
  const comm = louvain(adj);
  const byComm = new Map<number, string[]>();
  for (const [rel, c] of comm) { if (!byComm.has(c)) byComm.set(c, []); byComm.get(c)!.push(rel); }
  const deg = (r: string) => [...(adj.get(r)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const claimed = new Set<string>();
  const nameOf = new Map<number, string>();
  // name biggest communities first so the largest keeps the clean directory label
  for (const [c, mem] of [...byComm].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])) {
    const hist = new Map<string, number>();
    for (const r of mem) { const d = dirModuleOf(r); hist.set(d, (hist.get(d) || 0) + 1); }
    const dom = [...hist].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    let label = dom;
    if (claimed.has(dom)) {
      const hub = mem.slice().sort((a, b) => deg(b) - deg(a) || a.localeCompare(b))[0];
      const base = path.basename(hub).replace(/\.[^.]+$/, "");
      label = `${dom}::${base}`;
      let k = 2;
      while (claimed.has(label)) label = `${dom}::${base}#${k++}`;
    }
    claimed.add(label);
    claimed.add(dom);
    nameOf.set(c, label);
  }
  const out = new Map<string, string>();
  for (const [rel, c] of comm) out.set(rel, nameOf.get(c)!);
  const q = modularityOf(adj, comm);
  log(`modules: ${nameOf.size} import-communities / ${out.size} source files — Louvain Q=${q.toFixed(3)}`);
  return out;
}

// ---------- stage 5: render ----------
const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "_");

function computeSignals(g: Graph) {
  const counts: Record<Kind, number> = { source: 0, test: 0, config: 0, doc: 0, output: 0, other: 0 };
  for (const f of Object.values(g.files)) counts[f.kind]++;
  const edges = Object.values(g.files).reduce((n, f) => n + f.imports.length, 0);
  const analyzed = edges > 0; // import graph is JS/TS-only; 0 edges = nothing to measure
  return { counts, analyzed, dead: deadCode(g), untested: untested(g), cycles: cycles(g), redundancy: redundancy(g) };
}

function renderPuml(g: Graph, sig: ReturnType<typeof computeSignals>): string {
  const L: string[] = [];
  L.push("@startuml codemap");
  L.push("' generated by codemap — deterministic snapshot, do not hand-edit");
  L.push("skinparam componentStyle rectangle");
  L.push("skinparam shadowing false");
  L.push("skinparam packageStyle rectangle");
  L.push("left to right direction");
  L.push("");
  const deadSet = new Set(sig.dead);
  const untestedSet = new Set(sig.untested);

  const mods = new Map<string, { loc: number; files: number; dead: number; untested: number }>();
  const edges = new Map<string, number>();
  for (const f of Object.values(g.files)) {
    if (f.kind !== "source" && f.kind !== "test") continue;
    const m = moduleOf(f.rel);
    const e = mods.get(m) || { loc: 0, files: 0, dead: 0, untested: 0 };
    e.loc += f.loc;
    e.files++;
    if (deadSet.has(f.rel)) e.dead++;
    if (untestedSet.has(f.rel)) e.untested++;
    mods.set(m, e);
    for (const imp of f.imports) {
      const tm = moduleOf(imp);
      if (tm !== m) edges.set(`${m} ${tm}`, (edges.get(`${m} ${tm}`) || 0) + 1);
    }
  }
  for (const [m, e] of [...mods].sort()) {
    const id = sanitize(m);
    const note = `${e.files}f ${e.loc}loc${e.dead ? ` !${e.dead}dead` : ""}${e.untested ? ` ~${e.untested}untested` : ""}`;
    const color = e.dead ? "#FFD7D7" : e.untested ? "#FFE9CC" : "#E8F0FE";
    L.push(`component "${m}\\n<size:10>${note}</size>" as ${id} ${color}`);
  }
  L.push("");
  for (const [k, n] of [...edges].sort()) {
    const [a, b] = k.split(" ");
    L.push(`${sanitize(a)} --> ${sanitize(b)} : ${n}`);
  }

  L.push("");
  L.push("legend right");
  L.push("  == codemap snapshot ==");
  L.push(`  ecosystems: ${g.ecosystems.join(", ")}`);
  L.push(`  source: ${sig.counts.source} | tests: ${sig.counts.test} | docs: ${sig.counts.doc}`);
  L.push(`  dead (no inbound, not entrypoint): ${sig.dead.length}`);
  L.push(`  untested source: ${sig.untested.length}`);
  L.push(`  import cycles: ${sig.cycles.length}`);
  L.push(`  config files: ${sig.counts.config}`);
  L.push("  --");
  L.push("  red=dead  orange=untested  purple=cycle  green=test");
  L.push("endlegend");
  L.push("@enduml");
  return L.join("\n");
}

function renderMd(g: Graph, sig: ReturnType<typeof computeSignals>, ts: string): string {
  const seams = new Map<string, number>();
  for (const f of Object.values(g.files)) {
    if (f.kind !== "source") continue;
    const m = moduleOf(f.rel);
    for (const imp of f.imports) {
      const tm = moduleOf(imp);
      if (tm !== m) seams.set(`${m} -> ${tm}`, (seams.get(`${m} -> ${tm}`) || 0) + 1);
    }
  }
  const ext = new Map<string, number>();
  for (const f of Object.values(g.files)) for (const e of f.externals) ext.set(e, (ext.get(e) || 0) + 1);
  const docs = Object.values(g.files).filter((f) => f.kind === "doc" && f.frontmatter);
  const configs = Object.values(g.files)
    .filter((f) => f.kind === "config")
    .map((f) => f.rel)
    .sort();
  const outputs = [...new Set(Object.values(g.files).filter((f) => f.kind === "output").map((f) => moduleOf(f.rel)))].sort();
  const moduleLoc = new Map<string, number>();
  for (const f of Object.values(g.files)) if (f.kind === "source") moduleLoc.set(moduleOf(f.rel), (moduleLoc.get(moduleOf(f.rel)) || 0) + f.loc);

  // ponytail: resolve real repo name from git remote, not path.basename — worker
  // worktrees suffix the dirname (`arc-skills-000134-…`) and would leak into snapshots.
  const remoteUrl = sh("git", ["config", "--get", "remote.origin.url"]);
  const projectName = remoteUrl ? path.basename(remoteUrl.trim().replace(/\.git$/, "")) : path.basename(g.root);

  const L: string[] = [];
  L.push("---");
  L.push(`generated: ${ts}`);
  L.push(`project: ${projectName}`);
  L.push(`ecosystems: [${g.ecosystems.join(", ")}]`);
  L.push(`source_files: ${sig.counts.source}`);
  L.push(`test_files: ${sig.counts.test}`);
  L.push(`graph_source: ${g.graphSource}${g.graphSource === "regex" ? " (approximate)" : ""}`);
  L.push(`graph_analyzed: ${sig.analyzed}`);
  L.push(`dead_count: ${sig.analyzed ? sig.dead.length : "null"}`);
  L.push(`untested_count: ${sig.analyzed ? sig.untested.length : "null"}`);
  L.push(`cycle_count: ${sig.analyzed ? sig.cycles.length : "null"}`);
  L.push("tool: codemap");
  L.push("---");
  L.push("");
  L.push(`# Codemap — ${projectName}`);
  L.push("");
  L.push("> Deterministic static snapshot (no LLM). Re-run after changes and diff `codemap.json` to see what moved.");
  L.push("");
  if (g.graphSource === "regex" && sig.analyzed) {
    L.push("> ⚠ **Import graph is regex-approximate** — `madge` not installed, so edges (hence dead/cycle signals) may include false positives from import-like text in comments or strings. Install for AST-accurate edges: `npm i -g madge`.");
    L.push("");
  }
  L.push("## Module shapes (LOC by module)");
  L.push(MODULE_MAP ? "_Modules = import communities (Louvain over the import graph)._" : "_Modules = directories (no import graph to cluster)._");
  L.push("");
  for (const [m, loc] of [...moduleLoc].sort((a, b) => b[1] - a[1]).slice(0, 25)) L.push(`- \`${m}\` — ${loc} LOC`);
  L.push("");
  L.push("## Seams (cross-module import edges)");
  L.push("");
  if (seams.size === 0) L.push("_none detected_");
  for (const [s, n] of [...seams].sort((a, b) => b[1] - a[1]).slice(0, 40)) L.push(`- ${s} — ${n}`);
  L.push("");
  if (MODULE_MAP && sig.analyzed) {
    const dirToCl = new Map<string, Set<string>>();
    const clToDir = new Map<string, Set<string>>();
    for (const f of Object.values(g.files)) {
      if (f.kind !== "source") continue;
      const cl = MODULE_MAP.get(f.rel);
      if (!cl) continue;
      const d = dirModuleOf(f.rel);
      (dirToCl.get(d) ?? dirToCl.set(d, new Set()).get(d)!).add(cl);
      (clToDir.get(cl) ?? clToDir.set(cl, new Set()).get(cl)!).add(d);
    }
    const splits = [...dirToCl].filter(([, v]) => v.size > 1).sort((a, b) => b[1].size - a[1].size);
    const merges = [...clToDir].filter(([, v]) => v.size > 1).sort((a, b) => b[1].size - a[1].size);
    L.push("## Layout vs clustering (dir ↔ community)");
    L.push("");
    L.push("_Modules grouped by import community, not folder. Disagreements are architecture leads._");
    L.push("");
    if (!splits.length && !merges.length) {
      L.push("_Layout and clustering agree — folders match import communities._");
    } else {
      if (splits.length) {
        L.push("**Directory split across communities** (leaky boundary / candidate split):");
        for (const [d, v] of splits.slice(0, 15)) L.push(`- \`${d}/\` → ${v.size} communities: ${[...v].sort().join(", ")}`);
        L.push("");
      }
      if (merges.length) {
        L.push("**Community spanning directories** (cross-cutting / candidate merge):");
        for (const [c, v] of merges.slice(0, 15)) L.push(`- \`${c}\` ← ${[...v].sort().join(", ")}`);
        L.push("");
      }
    }
  }
  if (!sig.analyzed) {
    L.push("## Signals — dead / untested / cycles");
    L.push("");
    L.push("_Not computed: the import graph is JS/TS-only and this repo's source is another language (Python/Go/Rust/unknown). Inventory, module shapes, configs and docs above are still accurate; treat dead/untested/cycle as **unmeasured**, not zero._");
    L.push("");
  } else {
  L.push(`## Dead code candidates (${sig.dead.length})`);
  L.push("");
  L.push("_Source files with no inbound import and not an entrypoint. Verify before deleting — dynamic/CLI/plugin loads aren't seen._");
  L.push("");
  for (const d of sig.dead.slice(0, 80)) L.push(`- \`${d}\``);
  if (sig.dead.length > 80) L.push(`- … +${sig.dead.length - 80} more`);
  L.push("");
  L.push(`## Untested source (${sig.untested.length})`);
  L.push("");
  L.push("_No test file imports it and no sibling test exists. Heuristic — wire up coverage for precision._");
  L.push("");
  for (const u of sig.untested.slice(0, 80)) L.push(`- \`${u}\``);
  if (sig.untested.length > 80) L.push(`- … +${sig.untested.length - 80} more`);
  L.push("");
  L.push(`## Import cycles (${sig.cycles.length})`);
  L.push("");
  for (const c of sig.cycles.slice(0, 20)) L.push(`- ${c.map((x) => `\`${x}\``).join(" <-> ")}`);
  if (!sig.cycles.length) L.push("_none detected_");
  L.push("");
  }
  L.push("## Possible redundancy");
  L.push("");
  const se = Object.entries(sig.redundancy.sameExport).sort((a, b) => b[1].length - a[1].length);
  const sb = Object.entries(sig.redundancy.sameBasename).sort((a, b) => b[1].length - a[1].length);
  if (se.length) {
    L.push("**Same exported symbol from multiple files** (higher signal — but verify: client/server pairs and shared type contracts legitimately share a name):");
    for (const [k, v] of se.slice(0, 15)) L.push(`- \`${k}\` → ${v.map((x) => `\`${x}\``).join(", ")}`);
    if (se.length > 15) L.push(`- … +${se.length - 15} more (see codemap.json)`);
    L.push("");
  }
  if (sb.length) {
    L.push("**Same filename in multiple dirs** (low signal — often normal per-package structure):");
    for (const [k, v] of sb.slice(0, 12)) L.push(`- \`${k}\` ×${v.length}`);
    if (sb.length > 12) L.push(`- … +${sb.length - 12} more (see codemap.json)`);
    L.push("");
  }
  if (!sb.length && !se.length) L.push("_none detected_");
  L.push("");
  L.push(`## Config files (${configs.length})`);
  L.push("");
  for (const c of configs) L.push(`- \`${c}\``);
  L.push("");
  L.push("## Top external deps");
  L.push("");
  for (const [e, n] of [...ext].sort((a, b) => b[1] - a[1]).slice(0, 25)) L.push(`- \`${e}\` — ${n} imports`);
  L.push("");
  L.push(`## Docs with frontmatter (${docs.length})`);
  L.push("");
  for (const d of docs.slice(0, 40)) {
    const fmKeys = Object.entries(d.frontmatter!)
      .slice(0, 4)
      .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
      .join(", ");
    L.push(`- \`${d.rel}\` — ${fmKeys}`);
  }
  L.push("");
  if (outputs.length) {
    L.push("## Output / log dirs");
    L.push("");
    for (const o of outputs) L.push(`- \`${o}/\``);
    L.push("");
  }
  return L.join("\n");
}

// ---------- main ----------
function isoStamp(): string {
  const head = sh("git", ["rev-parse", "--short", "HEAD"]);
  const d = new Date();
  return `${d.toISOString()}${head ? ` @${head.trim()}` : ""}`;
}

function main() {
  log(`root=${root}`);
  const ecosystems = detect();
  log(`ecosystems: ${ecosystems.join(", ")}`);
  const allRel = listFiles();
  log(`files: ${allRel.length}`);
  const files = inventory(allRel);
  // Prefer madge's AST graph for JS/TS edges; regex stays as the fallback.
  let graphSource: "madge" | "regex" = "regex";
  const mg = madgeAvailable() ? madgeGraph(allRel, new Set(allRel)) : null;
  if (mg) {
    graphSource = "madge";
    for (const rec of Object.values(files)) {
      if ((rec.kind === "source" || rec.kind === "test") && (rec.lang === "ts" || rec.lang === "js")) rec.imports = mg[rec.rel] ?? [];
    }
    log(`graph: madge (AST-accurate) — ${Object.keys(mg).length} files`);
  } else {
    log("graph: regex (approximate — install madge for AST-accurate JS/TS edges: npm i -g madge)");
  }
  const g: Graph = { root, ecosystems, files, entrypoints: [], graphSource };
  g.entrypoints = findEntrypoints(files);
  log(`entrypoints: ${g.entrypoints.length}`);
  const cm = clusterModules(g);
  if (cm.size) MODULE_MAP = cm;
  else log("modules: directory grouping (no import graph to cluster)");
  const sig = computeSignals(g);
  log(`dead=${sig.dead.length} untested=${sig.untested.length} cycles=${sig.cycles.length}`);

  fs.mkdirSync(outDir, { recursive: true });
  const ts = isoStamp();
  const ir = {
    generated: ts,
    root,
    ecosystems,
    graphSource: g.graphSource,
    modules: MODULE_MAP ? Object.fromEntries([...MODULE_MAP].sort()) : undefined,
    counts: sig.counts,
    entrypoints: g.entrypoints,
    dead: sig.dead,
    untested: sig.untested,
    cycles: sig.cycles,
    redundancy: sig.redundancy,
    files: Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, { kind: v.kind, loc: v.loc, lang: v.lang, imports: v.imports, externals: v.externals }]),
    ),
  };
  fs.writeFileSync(path.join(outDir, "codemap.puml"), renderPuml(g, sig));
  fs.writeFileSync(path.join(outDir, "codemap.md"), renderMd(g, sig, ts));
  fs.writeFileSync(path.join(outDir, "codemap.json"), JSON.stringify(ir, null, 2));
  log(`wrote ${path.relative(root, outDir) || "."}/{codemap.puml,codemap.md,codemap.json}`);

  process.stdout.write(`${path.join(outDir, "codemap.md")}\n`);
}

main();
