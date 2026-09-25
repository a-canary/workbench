# Evidence — coding-standards

Short evidence record behind the `coding-standards` skill. Every rule in `CODING.md` traces to a measurement here. Experiments E1–E7 were run 2026-05-28; E8/E9 (the language probes corrected below) on 2026-05-29. Toolchains: Go 1.22.3, Rust 1.93.1 (+clippy, rust-analyzer), Bun 1.3.13 / tsc 6.0.3, on Linux x86_64.

This document supersedes two earlier over-claims (Go auto-fix "parity"; rustc-JSON "~7× prose"). Where it corrects a prior finding it says so explicitly — the corrections are the point.

---

## TL;DR

| Claim | Verdict | Rule |
|---|---|---|
| Structured/terse compiler diagnostics shorten the agent repair loop | Holds — all three tiers emit actionable, localized errors | U-3, U-4 |
| Raw `rustc --error-format=json` is cheap enough to feed back | **Refuted** — it is 63× the cheapest prose for one error | U-4 |
| Strict-by-default catches real bugs loose mode ships silently | Holds — loose compiled to a silent `undefined`; strict caught it | U-2 |
| Go is at auto-fix-loop *parity* with Rust | **Refuted** — Go is format-apply + detect-only; Rust auto-*applies* | U-3, W-6 |
| Go costs no agent throughput vs TS | **Refuted** — 31% real-repo SWE-bench resolution vs Rust 58%, with iteration | W-6 |
| Rust is hard for AI (the "21%" reading) | **Refuted** — Rust is the *top* language on SWE-bench Multilingual (58.1%) | W-6 |
| Java/C# carry the most AI-generated vulns | Holds (Veracode 2025: 72% / 45%) | U-5 |

---

## E9 — Diagnostic quality and cost, head-to-head (the load-bearing probe)

The W-6 thesis is "structured diagnostics shorten the repair loop." We tested whether that thesis discriminates between languages, using **one identical bug** in each of Go / Rust / TS: a function returns a fallible/optional value and the caller uses it as if it were the bare value.

```
Go:   port := parsePort("8080")          // parsePort returns (int, error)
Rust: let port = parse_port("8080");     // parse_port returns Result<i32,_>
TS:   const port = parsePort("8080");    // parsePort returns number | null
      ... port + 1
```

All three compilers caught it and localized it to the right line:

| Lang | First diagnostic | Code | Names root cause? | Inline fix? |
|---|---|---|---|---|
| Go | `assignment mismatch: 1 variable but parsePort returns 2 values` | — | yes (most direct of the three) | no |
| Rust | `cannot add {integer} to Result<i32, ParseIntError>` + note on missing `Add` impl | E0369 | yes | no |
| TS | `'port' is possibly 'null'` | TS18047 | partial (symptom, not the `\|null` return) | no |

**Finding:** Go's diagnostic is as actionable as the others — arguably the most direct. So Go's weak agentic performance on real repos (next section) is **not** a diagnostic-quality problem. None of the three auto-suggests a fix for a *semantic* bug; that always returns to the model.

### Diagnostic token cost (same single error)

```
TS  tsc --pretty false        60 chars   (~15 tok)   1×
Go  go build                  88 chars   (~22 tok)   1.5×
Rust --error-format=short    123 chars   (~31 tok)   2×
Rust prose (default)         710 chars  (~178 tok)   12×
Rust --error-format=json    3799 chars  (~950 tok)   63×   ← embeds the full E0369 explanation essay
```

**Correction to the earlier E1b "~7×" figure:** that compared JSON to *Rust's own prose*. Against the cheapest terse output, raw JSON is **63×**. → **U-4:** feed `--error-format=short` (carries file:line:col+code+message, grep-parseable, 1/30th the JSON cost), or parse JSON and discard the `explanation` field. Never feed raw JSON.

---

## E2/E7 — Strict-by-default catches what loose mode ships silently

The original E2 bug class was invalid: modern `tsc` (6.0.3) applies `strictNullChecks` even without `--strict`, so a null-deref is caught in both modes. The *real* strict/loose divergence is `noImplicitAny`:

```ts
function lengthOf(x): number { return x.length; }   // x: implicit any
console.log(lengthOf(42));                           // number has no .length
```

```
tsc --noImplicitAny false   → exit 0   (compiles clean)
tsc --strict                → error TS7006: Parameter 'x' implicitly has an 'any' type
bun run (loose)             → prints `undefined`   (silent wrong result, no crash, no error)
```

**Finding:** loose mode ships a silent `undefined`; strict catches it at compile time at ~zero added agent cost. → **U-2** stands. (Python mirror, E7: default `mypy` reports "Success" on unannotated code by treating it as `Any`; only `--strict` + `disallow_untyped_defs` catches the None-deref — Python is the loosest tier by default.)

---

## E8/E9 — Auto-fix *apply* depth is not uniform

"Auto-fix pass before the LLM" (U-3) only saves tokens if the tool **applies** the fix. We separated *detect* from *apply*:

**Rust — auto-applies (verified):**
```
src/main.rs:  let mut x = 5;   // `mut` unnecessary → MachineApplicable
cargo fix --allow-dirty --allow-no-vcs
  → Fixed src/main.rs (1 fix)        # `let mut x` → `let x` written to disk
  → Finished                          # recompiles clean, zero LLM tokens
```

**Go — format-applies, but only *detects* semantics:**
```
gofmt -w main.go          → reindents / fixes imports          (APPLIED, deterministic)
go vet .                  → "fmt.Printf format %s has arg x of wrong type int"
                            (DETECTED — no fix applied; the %s→%d edit is the LLM's job)
go vet -fix               → flag provided but not defined       (1.24+ only; box is 1.22.3)
go fix                    → invalid -go=go1.22.3                (API-migration tool, not a linter)
gopls / staticcheck / errcheck / golangci-lint → not installed
```

**Finding:** Rust's zero-token channel covers format **and** machine-applicable semantic fixes. Go's covers **format only** (`gofmt`); `go vet` is detect-only, and the semantic-apply path (`gopls source.fixAll`, `go vet -fix` on Go ≥1.24, staticcheck) is not guaranteed present. **Correction to the earlier E8 claim of "auto-fix-loop parity":** the "green" in the original E8 run came from a manual edit, not a tool. Go is *detect-then-LLM*, not auto-fix. → **U-3 table, W-6, W-7.**

---

## Real-repo agentic resolution by language (SWE-bench Multilingual)

Source: <https://www.swebench.com/multilingual.html> — 300 real GitHub-PR tasks across 42 repos, 9 languages. **Methodology matters for our case:** evaluated with the **SWE-agent** scaffold (agentic loop — the model executes code, runs the hidden fail-to-pass / pass-to-pass tests, observes output, and **iterates** under a $2.50/task budget). It is NOT one-shot. Reported model: **Claude 3.7 Sonnet**, 43% overall (128/300). The per-language chart is this one model's result, not a pooled field.

| Language | Resolution rate | n | Repos (examples) |
|---|---|---|---|
| **Rust** | **58.1%** | 43 | — (top of the board) |
| Java | 53.5% | 43 | gson, druid, lucene, rxjava |
| PHP | 48.8% | 43 | — |
| Ruby | 43.2% | 44 | — |
| *average* | *42.6%* | — | — |
| JS/TS | 34.9% | 43 | — |
| **Go** | **31.0%** | 42 | caddy, terraform, prometheus, hugo, gin |
| C/C++ | 28.6% | 42 (C) + 12 (C++) | redis, jq, micropython, valkey, fmt, json |

**Two findings that drive W-6:**

1. **Rust is the *easiest* language to resolve here, not the hardest.** The often-cited "Rust 21% SWE-bench" number is **task-size confounded** (those Rust tasks averaged ~10× the lines); on equal-sized real-repo tasks Rust tops the board at 58.1%. Promoting a module to Rust does **not** cost agent success — it correlates with the *highest* success. → removes the main objection to W-6's promotion path.

2. **Go is near the bottom (31.0%) — below average, below JS/TS, ~half of Rust — *with* the iteration loop available.** Because Go's diagnostics are perfectly actionable (E9), this is a *reasoning-on-real-repos* gap, not a tooling gap, and iteration didn't close it. The rosier **Aider polyglot Go 71.8%** is self-contained Exercism katas; our workers do real-repo issue resolution, which is the harder column. → W-6 keeps Go as a permitted explicit tier but drops the "no throughput cost" framing.

**Caveats (stated, not hidden):** single model (Claude 3.7 Sonnet, pre-Opus-4.x; newer models may have narrowed the Go gap — no one has published the split to confirm). Small n per language (~42). Go's tasks lean on large infra repos (terraform, prometheus) that may be intrinsically harder, so some of the gap is repo-selection. None of these caveats touch the loop-availability question, which the methodology rules out.

---

## External evidence carried in (not re-run here)

- **TDD** — Test-Driven Agentic Development (arXiv 2603.17973): 70% lower regression rate, 72% fewer pass-to-pass failures. Strongest single guardrail in the review → **U-1** mandatory.
- **Type-constrained decoding** — ETH (arXiv 2504.09246): >50% fewer compile errors when the model is constrained by the type system; corroborates U-2/U-3.
- **Repair-iteration plateau** — IaC study (arXiv 2411.19043): feedback gains decay then plateau → **U-3** caps auto-repair at 3 iterations.
- **Security by language** — Veracode 2025 GenAI Code Security: % of AI completions carrying an OWASP Top-10 vuln — Java 72%, C# 45%, JS ~43%, Python ~38%. **Go, Rust, TS were not tested** → **U-5** (no Java/C# default) and W-6's explicit "no Veracode number for Go" caveat.
- **Resource tiers** — MultiPL-E (arXiv 2208.08227): Go = medium-resource, Rust = low-resource; performance tracks training-corpus *volume*, recoverable with balanced data (BabelCode, arXiv 2302.01973: +66% low-resource for −13% high-resource). Context for why low-resource ≠ "AI is bad at it."

---

## Reproducing the probes

All E9/E8 probes are pure CLI on the three toolchains above. The shapes:

```bash
# E9 diagnostic quality + cost — write the identical bug in each lang, then:
go build .                                   # Go prose
rustc --edition 2021 --error-format=short main.rs -o /dev/null   # Rust terse
rustc --edition 2021 --error-format=json  main.rs -o /dev/null | wc -c   # 63× cost
tsc --pretty false --strict main.ts          # TS terse

# E2 strict vs loose
tsc --noImplicitAny false anyloose.ts   # exit 0  (ships)
tsc --strict            anyloose.ts     # TS7006  (caught)

# E8 auto-apply depth
cargo fix --allow-dirty --allow-no-vcs        # Rust: applies to disk
gofmt -w main.go                              # Go: format applied
go vet .                                      # Go: detected, NOT applied
```

Raw run logs are in the originating job transcript (job c2eafe37). KE: `research/ke-e8-go`, `research/ke-best-practices-synthesis`, `research/ke-e1*`, `research/ke-e2-strict`, `research/ke-e6-ts-codefix`, `research/ke-e7-python`.
