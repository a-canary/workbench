# CODING.md — arc factory coding standards (defaults)

Baseline engineering rules. **Defaults, not laws** — a direct user instruction, or a project's own `CODING.md` / `AGENTS.md` / `CHOICES.md`, overrides anything here. Apply where nothing more specific has spoken.

Two audiences:
- **(F) Factory implementation** — arc-agents' own framework code (Bun/TypeScript).
- **(W) Worker output** — the software the factory's workers produce, in whatever language the task targets.

Evidence: experiments E1–E9 (job c2eafe37, 2026-05-28/29); Veracode 2025 AI-code security report; Test-Driven Agentic Development (arXiv 2603.17973); type-constrained decoding (ETH, arXiv 2504.09246); SWE-bench Multilingual per-language results. The full evidence write-up is **[EVIDENCE.md](EVIDENCE.md)**. Vercel Zero (vercel-labs/zerolang) was evaluated and **not adopted** — its one load-bearing idea (agent-readable structured diagnostics) already exists in Rust and TS. Steal the thesis, not the toolchain; revisit Zero only at ≥0.5 + registry + published agent fix-rate benchmarks.

---

## Universal rules (F and W)

### U-1 — TDD is mandatory
Test before implementation; gate on test presence AND green. Strongest guardrail evidence in the review (TDAD: 70% lower regression rate, 72% fewer pass-to-pass failures). Vertical slices, one test → one impl → repeat (see the `tdd` skill). Override only with explicit user sign-off for throwaway spikes.

### U-2 — Strict-by-default
Make the type system catch the bug before the model has to. Per-language strict settings in §W-7 / §F-1. Strict caught real None-deref crashes that loose mode shipped silently, at ~zero added agent cost (E2/E7). The trade is asymmetric in favor of strict.

### U-3 — Deterministic auto-fix pass before the LLM
Every tier has a zero-LLM-token machine-fix channel. Run it FIRST; only invoke the model on errors with no machine-applicable fix. Cap auto-repair at **3 iterations** (feedback gains plateau — IaC study arXiv 2411.19043).

Auto-apply depth is NOT uniform across tiers — verified empirically (E8/E9, 2026-05-29):

| Language | Auto-**apply** channel | Depth | Mechanism |
|---|---|---|---|
| Rust | `cargo fix` / `rustc` `MachineApplicable` | **format + semantic** | auto-applies `suggested_replacement` to disk, zero tokens, recompiles clean (E9-verified) |
| TypeScript | tsserver `getCodeFixesAtPosition(file,start,end,[codes],{},prefs)` | format + many semantic | apply returned text-change spans (NOT `tsc`) |
| Python | `ruff --fix` | format + safe-lint | apply where `applicability:"safe"` (47% of real lint issues auto-fixable, E7) |
| Go | `gofmt -w` (apply) + `go vet` (**detect-only**) | **format only** | `gofmt` auto-applies formatting; `go vet` *detects* semantic bugs but does NOT apply a fix. Semantic auto-apply needs gopls `source.fixAll` / `go vet -fix` (Go 1.24+) / staticcheck — none guaranteed present (E8/E9). Treat Go as detect-then-LLM, not auto-fix. |

### U-4 — Slim the diagnostics you feed back; prefer `short` over raw JSON
Raw `rustc --error-format=json` embeds the full explanation essay per diagnostic. Measured on one identical error (E9): JSON = 3799 chars (~950 tok), **63× the cheapest prose** (TS `tsc --pretty false` = 60 chars). The earlier "~7×" was JSON-vs-Rust-prose; against terse output it is far worse.

**Rule:** prefer the compiler's terse machine line — `rustc --error-format=short` (123 chars, file:line:col + code + message, ~1/30th the JSON cost) or `tsc --pretty false` / `go build` prose, all of which are already grep-parseable. Use `--error-format=json` ONLY when you parse it and **discard the `explanation` field** before feeding the worker — otherwise you pay the 63× tax. Fetch the long explanation on demand only for an unfamiliar code.

### U-5 — No Java / C# as a default
Veracode 2025: Java 72% / C# 45% of AI-generated code carries an OWASP Top-10 vuln (vs JS ~43%, Python ~38%). Use only when a project explicitly requires them.

### U-6 — AXI-shape agent-facing output
When a CLI / tool / command emits output an **agent** consumes (search hits, status, query answers — the general case U-4 covers for compiler diagnostics only), shape the agent path for token economy + machine parsing per **AXI** ([axi.md](http://axi.md)):
- **Minimal schema** — 3–4 load-bearing fields; drop anything the consumer restates or ignores (e.g. a title the summary already repeats).
- **Bounded fields** — truncate long values to a gist with a size hint + an escape-hatch flag (`--full`); never dump unbounded bodies by default.
- **Definitive empty states**, structured errors + non-zero exit codes, and no interactive prompts on the non-TTY path.
- **Contextual disclosure** — a next-step command template in the footer (`next: ke query "…"`).

Generalizes U-4 to every agent-consumed surface. Keep human-pretty output for TTY; AXI shaping is the default for the agent path. Proven on `ke search` (PR a-canary/ke#59): title↔summary dedup + gist truncation cut output ~10%.

### U-7 — Anchor Edit `old_string` on freshly-grepped bytes, not remembered excerpts
Exact-string Edit requires a byte-for-byte match of the current file. Matching against a *remembered* excerpt (from an earlier Read, a truncated dump, or reconstructed indentation) produces "could not find the exact text" failures — off-by-one whitespace, tabs-vs-spaces, a line that was already reflowed. Two-plus such failures in a row on the same edit is the signal to STOP retrying blind and re-anchor:
- **Re-anchor before the 3rd attempt, not after.** `grep -n` a short, unique token near the edit site, then `Read` that exact `offset`/`limit` range so `old_string` is copied from live bytes — never re-typed from memory.
- **Shrink the anchor.** Match the *smallest* unique surrounding string, not a multi-line block; fewer bytes copied = fewer whitespace traps.
- **Whitespace-ambiguous region** (mixed tabs/spaces, trailing spaces) → prefer `Write` of the whole small file, or a ranged `Read` immediately before the Edit so the copy is fresh.

Prevents the zero-productivity spiral where 3+ Edits fail and no change lands (KE optimization session 2026-04-20). Costs one `grep -n` + one ranged `Read`; saves the failed-retry loop.

---

## (F) Factory implementation

### F-1 — TS strict stays enforced
`strict:true`, `noUncheckedIndexedAccess`, `noImplicitOverride` (already true in arc-agents). Add `exactOptionalPropertyTypes:true`. Keep the typecheck merge-gate hard.

### F-2 — Wire diagnostics into the worker loop
Today the merge-gate runs `bun run typecheck` and discards output (exit-code only); headless workers tee raw stdout to a logfile. Change the typecheck gate to capture diagnostics via the TS Compiler API into the slim payload (U-4) and feed THAT to a failed worker before it retries. Run the auto-fix pass (U-3) first.

### F-3 — Validation at every external boundary
Zod-parse any input crossing a process / network / file edge. Promote from the current selective use to required at boundaries.

### F-4 — Security gate
Wire the already-installed `gitleaks` + `bun audit` into the merge-gate as a gate. Fail on any detected secret or high-severity advisory. (Currently installed but unwired — the highest-value unguarded gap.)

---

## (W) Worker-produced software

### W-6 — Routing axis: blast-radius + lifetime, not just runtime
Default to **strict TypeScript**. Promote a module to **Rust** when ANY of:
- runs >30 min/day, OR
- handles money / credentials / user-data, OR
- has ≥2 dependents, OR
- has run unattended in prod ≥2 weeks.

**Go** is a permitted third production tier — an explicit choice, not auto-routed. Reach for it over Rust when you want a typed + GC'd service with less ceremony than Rust (no borrow checker, no memory-safety guarantee) and Go's pulls apply: stdlib concurrency, networking, single-binary deploy. Strictness sits between Python and Rust. **Two costs to weigh against TS/Rust, measured (E8/E9):**
- **Shallower auto-fix loop.** Go's zero-token channel is `gofmt` (format) + `go vet` (detect-only) — NOT auto-apply parity with Rust's `cargo fix`. Semantic fixes go back to the LLM. Budget more repair iterations.
- **Lower agentic resolution on real repos.** SWE-bench Multilingual (SWE-agent, iteration + execution feedback, $2.50/task, Claude 3.7 Sonnet) resolved Go at **31.0%** — below the 42.6% average, below JS/TS (34.9%), and ~half of Rust (58.1%) — *with* the feedback loop available. Go's diagnostics are perfectly actionable (E9), so this is a reasoning-on-real-repos gap, not a tooling gap. (Aider polyglot's rosier Go 71.8% is self-contained katas, not real-repo issue resolution — our workers do the latter.)

Caveat: **no Veracode security number exists for Go** (the 2025 report tested only Java/Python/C#/JS), so its security profile is unmeasured here, not endorsed. Net: Go is permitted and useful where its concurrency/single-binary pulls dominate, but it is NOT free relative to TS — prefer strict TS by default and Rust for the promotion triggers.

**Python** is permitted only as a deliberate ML/research/prototype tier — never as the strict-by-default production tier (it has the best mainstream vuln profile and highest agent success rate, but is the loosest by default; see W-7).

### W-7 — Strict-by-default in every tier the worker emits
- **TS:** `strict:true` + `noUncheckedIndexedAccess` + Zod at boundaries.
- **Python:** if shipped past the prototype line it MUST gate `ruff` + `mypy --strict` + `disallow_untyped_defs=true` + Pydantic at boundaries. The trap (E7): default `mypy` reports "Success" on unannotated code because it treats it as `Any`. Without the annotations + `disallow_untyped_defs`, strictness is theater.
- **Go:** the alternate production tier; `go vet` + `gofmt` enforced and gated. `gofmt` is canonical (non-negotiable, deterministic, auto-applied). `go vet` *detects* and feeds the repair loop but does **not** auto-apply (W-6 / U-3) — for semantic auto-apply install `gopls` (`source.fixAll`) or Go ≥1.24 (`go vet -fix`); without them the fix step is the LLM's. Errors-as-values is the idiom — don't paper over with `_`-discarded errors; `errcheck` in the gate.
- **Rust:** the promoted tier; `--error-format=json` feeds the repair loop natively.

### W-8 — Auto-fix pre-pass + slim diagnostics
Apply U-3 and U-4 to worker output too, per the target language.

### W-9 — TDD + dependency hygiene
U-1 applies to worker output. Pin dependencies. Python research repos must add `pip-audit` to their gate (currently unaudited).

---

## Open calibration (not yet settled by experiment)
- **E3** — promotion-threshold numbers (TS→Rust velocity-vs-defect curve). The qualitative axis in W-6 ships now; E3 recalibrates the thresholds with real worker-loop data later. Direction is settled; the exact numbers are not.
- **E4** — TDD on/off on our own stack. Confirmatory only; external evidence (TDAD) already strong enough to mandate U-1.
