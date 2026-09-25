---
name: skillopt-lite
description: SkillOpt-style champion/challenger optimization loop for ONE agent-spec or skill text artifact, replaying real historical uses mined from transcripts. Use when the user wants to optimize an agent spec (e.g. waste-analyst), A/B a rewritten skill against the current one on real past inputs, or asks to "skillopt" an artifact. Promotes only on Wilson-gated pairwise wins.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# SkillOpt-Lite

Optimize one text artifact (agent spec / skill body) by replaying its real historical
invocations: champion = current spec, challenger = your rewrite. Everything runs
through one bun CLI: `bun skills/skillopt-lite/skillopt.ts <cmd>`.

First target: the waste-analyst agent spec (`~/.claude/agents/waste-analyst.md`,
canonical copy `skills/token-waste/agents/waste-analyst.md`).

## Pipeline

1. **mine** — `mine --agent waste-analyst --days 14 --out dataset.jsonl`
   Scans `~/.claude/projects/*/*.jsonl` for Task-tool calls with
   `input.subagent_type == <agent>`; captures `{id, session, ts, prompt, output}`
   (prompt = replay context; output = historical result if recoverable, else null;
   both capped ~8k chars).
2. **split** — `split --in dataset.jsonl --test-frac 0.5 --seed 42`
   Deterministic seeded shuffle → `train.jsonl` + `test.jsonl`.
   The TEST split must stay unbiased random — never curated toward bad rows
   (regression-to-mean would fake improvement). Only train may be re-ordered.
3. **reflect** (driving agent, no subcommand) — read the champion spec + train rows,
   especially rows where the historical output was weak (missing deliverable, broken
   JSON, bloat). Write ONE challenger spec variant to `challenger.md`: a full rewrite
   of the spec file, same contract, changed instructions. One hypothesis per variant.
4. **replay** — run BOTH specs over the untouched test split:
   `replay --spec champion.md --rows test.jsonl --out replays-champion.jsonl`
   `replay --spec challenger.md --rows test.jsonl --out replays-challenger.jsonl`
   Default model `cli/claude/haiku` (waste-analyst's production model). Spec + row
   prompt are folded into one user message (the cli proxy refuses system roles).
5. **judge** — `judge --rows test.jsonl --a replays-champion.jsonl --b replays-challenger.jsonl --model smart --out verdicts.jsonl`
   Pairwise blind, X/Y assignment randomized per row (seeded hash of id, recorded as
   `aIsX`). Correctness first (Output contract, strict JSON, deliverable present),
   efficiency as tiebreak.
6. **gate** — `gate --verdicts verdicts.jsonl`
   Drops ties, computes Wilson 95% lower bound on challenger win rate.

## Promotion rule

PROMOTE only when Wilson 95% lower bound > 0.5 (printed by `gate`). On PROMOTE:
challenger becomes the new champion — copy it over the canonical spec file, commit,
keep the old champion in git history. On HOLD: keep champion, reflect again with a
new hypothesis (loop from step 3). Never promote on point estimate, small n, or
self-judged results — the judge model must differ from the replay model.

## Rollout gate (tool-heavy skills)

Replay is a cheap hypothetical screen: chat-only, no tools — it tests what the
agent *says*, not what it *does*. For tool-heavy skills, finalists that pass
replay get a `rollout`: real sandboxed execution in arc-factory's arcsim
container (docker, network-none inner sandbox, MINIMAX_API_KEY only — no
Anthropic key, no host home/vault).

`rollout --rows test.jsonl --spec challenger.md --out rollouts-challenger.jsonl [--factory ~/repos/arc-factory] [--limit N] [--concurrency 1]`

Per row it writes spec.md + prompt.txt to a temp dir, points `ARCSIM_RESULTS`
at it (run.sh mounts that dir at `/results`), and runs
`<factory>/bench/rollout-one.ts` inside arcsim; `out.json`'s `output` lands as
`{id, output}` — the same shape replay writes, so the same judge/gate consumes
both. Failed rows emit `output: ""` and the run continues. Docker is heavy:
default concurrency 1, use `--limit` while iterating.

For agents whose prompts reference input files, pre-stage them:
`rollout --staged staged/index.jsonl ...` where each row is `{id, dir}` and
`dir` holds `prompt.txt` + the input files (prompt paths rewritten to
`/results/...`). Each dir is copied per-row (arms never share state) and
chmod'd readable (container uid differs from host).

Output semantics: rollout-one.ts invokes pi directly (not ProgramBench
`solve()`); `output` is the agent's real final text after sandboxed tool
execution — same shape replay writes, judged pairwise the same way.
GOTCHA: rollout truncates `--out` at start — resume to a SEPARATE file and
concat, never re-point a partial one.

## Self-check

`bun skills/skillopt-lite/skillopt.ts selftest` — Wilson math, split determinism,
judge-parse fixtures. Run before trusting a fresh checkout.
