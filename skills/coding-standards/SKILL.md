---
name: coding-standards
description: Default language-routing, strictness, diagnostics, and TDD rules for the arc software factory and the software its workers produce. Use when writing, reviewing, scaffolding, or routing any coding task, or when deciding what language/tooling a module should use. These are DEFAULTS — explicit user or project instructions override them.
license: MIT
---

# Coding Standards (defaults)

The baseline engineering rules for the arc factory **and** the software the factory's workers produce. Evidence-backed (experiments E1–E7, job c2eafe37; Veracode 2025; TDAD arXiv 2603.17973; ETH arXiv 2504.09246).

**These are defaults, not laws.** A direct user instruction or a project's own `CODING.md`/`AGENTS.md`/`CHOICES.md` overrides anything here. When a project document conflicts with this skill, the project wins. When the user says otherwise in-task, the user wins. Apply these only where nothing more specific has spoken.

The full ruleset is in **[CODING.md](CODING.md)** — read it before routing a coding task to a language or setting up a repo's gates.

## The one-screen version

1. **Route by blast-radius + lifetime, not just runtime.** Default to strict TypeScript. Promote a module to Rust when it touches money/credentials/user-data, has ≥2 dependents, runs >30 min/day, or has run unattended in prod ≥2 weeks. Go is an explicit third production tier (typed + GC'd, less ceremony than Rust) when its stdlib/concurrency/single-binary pulls apply — but it is NOT free: its auto-fix loop is shallower than Rust's (detect-only `go vet`, not auto-apply) and it resolves real-repo SWE-bench issues at ~half Rust's rate (31% vs 58%) even with iteration. Python is a deliberate ML/research/prototype tier only.
2. **Strict-by-default, every tier.** TS `strict:true` + `noUncheckedIndexedAccess` + validation at boundaries. Python is the *loosest* tier unless you enforce `ruff` + `mypy --strict` + `disallow_untyped_defs` + Pydantic-at-boundaries — otherwise its strictness is theater.
3. **Run a deterministic auto-fix pass before spending model tokens.** Rust `cargo fix` (auto-applies, format+semantic) / TS tsserver `getCodeFixesAtPosition` / `ruff --fix`. Go is the exception: `gofmt` auto-applies but `go vet` only *detects* — Go semantic fixes go back to the LLM unless gopls/Go≥1.24 is present. Only invoke the LLM on errors with no machine-applicable fix. Cap auto-repair at 3 iterations.
4. **Feed terse diagnostics, not raw JSON.** Raw `rustc --error-format=json` is **63× the tokens** of the cheapest prose (measured). Use `--error-format=short` / `tsc --pretty false` / `go build` — or parse JSON and discard its `explanation` field before feeding the worker.
5. **TDD is mandatory.** Best-evidenced guardrail in the whole review (70% regression cut). Test before impl; gate on presence + green.
6. **No Java/C# as a default** (Veracode 72%/45% OWASP-vuln rate).
7. **Inspect existing state before writing code against it.** Any code targeting a DB, an API, a config schema, or existing infra: read the *live* shape first — `.schema`/`PRAGMA table_info` for a table, `--help`/the route table for a CLI/API, `ls`/`stat` for a file the plan calls "missing." Design against what exists, never an assumed shape. A missing-file error (ENOENT) means *create*, not *wire* — do not project familiarity with infra you have not confirmed exists. One `sqlite3 db .schema` (or one `--help`) up front is cheaper than a mid-build pivot: skipping it forced a full redesign of scan/gc scripts after discovering a 247k-row DB with a different schema already indexed (~25k tokens, 20260724), plus repeated FK/NOT-NULL/enum failures the live schema would have prevented.
