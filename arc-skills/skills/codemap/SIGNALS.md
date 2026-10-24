# Signals — definitions, caveats, tuning

Every signal is a cheap static heuristic. Treat as a lead, not a verdict.

## Pipeline stages

`detect → inventory → graph → signals → render`

1. **detect** — ecosystem from marker files (`package.json`, `tsconfig.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`).
2. **inventory** — file list via `git ls-files --cached --others --exclude-standard` (respects `.gitignore`); fallback walk skips `node_modules`/`dist`/`coverage`/`__pycache__`/`.venv`/`target`/`.next`. Each file classified: source / test / config / doc / output / other. LOC counted; `.md` frontmatter parsed.
3. **graph** — JS/TS edges come from **madge** (AST-based) when it's installed (`npm i -g madge`) — it reads the real syntax tree + tsconfig, so it never mistakes an import inside a comment or string for a real edge. When madge is absent, falls back to the built-in **regex** extractor (labelled `graph_source: regex (approximate)` in frontmatter, with a warning in the report): it greps `import`/`export…from`/`require`/dynamic `import()` specifiers and resolves relative ones to local files (tries `.ts .tsx .js .jsx .mjs .cjs .py .go .rs`, `index.*`, `__init__.py`, and `.js`→`.ts` rewrite). A bare specifier is first matched against **workspace package names** (each `package.json` `name` → its dir+entry) and **tsconfig `paths` aliases**; only specifiers that resolve to nothing local become external deps. Exported symbol names extracted best-effort — names that are *re-exported* (`export { X } from "./y"`) are attributed to the defining file, not the barrel, so re-exports don't inflate redundancy.
4. **signals** — dead, untested, cycles, redundancy (below).
5. **render** — PlantUML + Markdown + JSON IR.

## Signal definitions

**Dead code candidate** — a source file that (a) has ≥1 export, (b) nothing imports, (c) isn't an entrypoint. The export requirement is deliberate: a file with no exports and no inbound is a standalone *script*, not dead library code.
- False positives: dynamic/`require(variable)` loads, plugin registries, CLI command auto-discovery, framework conventions (Next.js pages, route files), reflection. Fixtures that are loaded as data show up here — expected.
- Entrypoints excluded: `package.json` `main`/`module`/`bin`/`exports`; files matching `index|main|cli|server|app|__main__`; anything under `benchmarks?|examples?|demos?|prototypes?|fixtures?|mocks?|__mocks__|stories|e2e|scripts?|bin`; generated files (`*.generated.*`, `*.gen.*`, `generated/` dirs); files with a `#!` shebang; all test files. (Prototype/fixture/generated code isn't hand-maintained library code, so it's exempt from the dead/untested bars.)

**Untested source** — an importable unit (has exports, not an entrypoint) that no test file imports *and* has no sibling test file (`foo.ts` ↔ `foo.test.ts`/`foo.spec.ts`/`foo_test.py`).
- Heuristic only — one-hop import from tests + naming. For precision, wire up coverage (`coverage-final.json`/`lcov`) and cross-reference; not yet read automatically.

**Import cycle** — strongly-connected component (size > 1) over the local import graph, via Tarjan's algorithm. Cycles hurt testability and incremental builds.

**Unmeasured vs zero.** Dead/untested/cycle all derive from resolved *local* import edges, which are JS/TS-only. When the graph has zero such edges (a Python/Go/Rust repo, or a JS/TS repo of standalone scripts that don't cross-import), these aren't `0` — they're *unmeasured*. The report then shows `graph_analyzed: false` in frontmatter, `dead_count`/`untested_count`/`cycle_count: null`, and a single "not computed" note in place of the three sections. Inventory, module shapes, configs and docs are still accurate. Don't read a missing graph as a clean bill of health.

**Redundancy** — two cheap structural hints, not semantic dedup:
- *Same exported symbol name* from multiple files (ranked first — higher signal).
- *Same filename* in multiple dirs (`utils.ts` ×3) — ranked second, low signal.
- Noise filtered: structural filenames that recur once per package (`index/types/store/routes/schema/constants/config/main`) and generic symbol names whose collision is usually coincidence (`Props/Config/Options/State/Result/Type/Data/…`). Re-exports excluded (see graph stage).
- **Known false positive: client/server pairs.** A symbol like `repairStreak` defined in both an API service (server DB logic) and a web store (thin fetch wrapper) shares a name by design — same name, different layer, *not* duplication. So is a shared type contract (`ProgressData`) intentionally declared on both sides. The signal can't tell these from real copy-paste; it flags the name, you read the bodies. The genuine hits look like a hand-synced constant array or a util copied verbatim across packages.

## Module shapes & seams

- **Module** — source files grouped into the nodes you see, by **import community** (hand-rolled deterministic Louvain over the undirected source-import graph). A module is "files that import each other a lot", regardless of folder. Each community is named by the plurality directory among its members (collisions disambiguated by the community's hub file, e.g. `src/core::pipeline`). Reported with a modularity score `Q` (≳0.3 = real community structure). When the graph has no JS/TS edges, modules fall back to directory grouping: top-level dir, or `src/<x>` / `lib/<x>` / `app/<x>` / `packages/<x>` one level deep. Test files and edgeless source files always use that directory rule.
- **Shape** = file count + LOC per module (in `codemap.md` and the diagram node label).
- **Seam** = a cross-module import edge; edge weight = number of imports crossing it. High-weight seams are your real coupling points. Edges are aggregated per module pair.

**Layout vs clustering (dir ↔ community)** — shown whenever an import graph exists. Compares the detected import communities against the folder layout; the disagreement is itself an architecture signal:
- *Directory split across communities* — one folder's files land in >1 community → a leaky boundary or a folder that should be split.
- *Community spanning directories* — one community draws files from >1 folder → cross-cutting code, or folders that should merge.
- These are leads, not verdicts: a tight utility imported everywhere, or a deliberate layered split, can show up here legitimately. Determinism: same graph → same communities (sorted node iteration, no randomness), so the section is stable to diff commit-to-commit.

## Tuning

- No flags — one best-quality process. Point it at a subdir to scope the map (`npx tsx codemap.ts ./src/foo`).
- Modules are grouped by import community (Louvain); directory grouping is the automatic fallback when there's no import graph.
- Output goes to a git-tracked `codemap/` dir. Commit it — then `git diff -- codemap/codemap.json` between any two commits (or `git diff main -- codemap/codemap.json`) is a structural delta for free: files +/-, newly-dead, cycles introduced/broken, seam-weight changes. The codemap dir is excluded from its own inventory, so it never shows up as churn.

## Extending to other languages

Import resolution and export extraction are JS/TS-first (madge for the graph, regex for exports). Python/Go/Rust currently get file inventory, LOC, config/doc/output classification, and module shapes, but the dependency graph (and therefore dead/cycle signals) is only fully wired for JS/TS. A multi-language aggregator was prototyped and trashed as an orphan; see git history if needed. The codemap today only emits JS/TS dead/cycle signals.

To add a language: extend `IMPORT_RE`/`EXPORT_RE` (or add a per-language extractor like `PY_IMPORT_RE`) and teach `resolveLocal` how that language maps a specifier to a file path. Everything downstream (signals, render) is language-agnostic once edges exist.

## Limitations (state these when reporting)

- **Graph source:** madge (AST) when installed — accurate. Regex fallback otherwise — it reads import-like text in comments/strings as real edges (false-positive edges → false cycles/dead flags) and misses macro-generated imports. The report's `graph_source` field tells you which ran; trust regex edges as leads, not facts.
- No type information; no call-graph (import-graph only). A file imported but whose exports are never *used* still counts as live.
- Coverage not read yet — "untested" is a naming/import heuristic.
- Monorepos: workspace package names (`@scope/pkg`) and tsconfig `paths` aliases **are** resolved to local files, so cross-package imports render as real seams instead of vanishing into "external deps". Resolution keys off each `package.json` `name`+entry and root `tsconfig.json`/`tsconfig.base.json` `paths` — exotic alias schemes (custom resolvers, per-package path overrides) can still fall through to external.
