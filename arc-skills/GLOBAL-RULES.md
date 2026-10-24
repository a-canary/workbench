# Agent behavioral rules (always-on)

Canonical source of always-on agent rules. Git-tracked. Loaded once per
session via each harness's user-level config symlink (`~/.pi/agent/AGENTS.md`,
`~/.claude/CLAUDE.md`, … → this file; see skills/install-behavioral-rules).
Deliberately NOT named AGENTS.md/CLAUDE.md: any walk-up context file carrying
this content would double-inject it. Repo-level AGENTS.md files are thin
pointers or repo-scoped rules only — never copies of this file.

**Before acting you MUST read `~/vault/user.md`** — operator identity, infra,
preferences, project constraints. `~/vault/USER.md` overrides this file on conflict.

## File boundaries

- **GLOBAL-RULES.md (public, this file)** — HOW globally: rules every agent needs every turn.
  Symlinked as each harness's user-level AGENTS.md/CLAUDE.md; one copy per session.
- **`~/vault/user.md` (private)** — WHO: operator identity, missions, communication style.
- **`~/vault/USER.md` (private)** — WHO override: infra, secrets, preferences. Overrides user.md on conflict.
- **`~/vault/missions.md` (private)** — WHY: global axis ranking (UM-IDs + principles).
- **`<repo>/CHOICES.md`** — WHAT per repo: mission, objectives, decisions.
- **`<repo>/AGENTS.md`** — HOW per repo: repo-scoped rules.
- **`<repo>/CONTEXT.md`** — Per-repo vocabulary.
- **`~/vault/ontology/OVERVIEW.md`** — Agentic harness ontology (meta map:
  harnesses, ledger/factory, LLM routing, knowledge, scheduling, roles).
  Placement policy: project-scoped maps live in the repo; meta maps in vault.
  Read the topic file when touching that subsystem; `findings.md` tracks
  open overlaps/conflicts/gaps (each ticketed in the ledger).

## Context loading

At session start, load these files into the system prompt:
- `~/vault/user.md`
- `~/vault/USER.md` (overrides user.md on conflict)

## Always-on universal rules

- **Markdown: never wordwrap — one concept per line.**
- **Prove before scaling.** Single manual run beats scheduled fleet.
- **Never re-Read a file already read this session** unless edited since.
  Includes pager dumps. `grep -n` to find values.
- **Never Read `tool-results/<id>.txt`** — already in context.
- **Grep large unseen files** (>~300 lines) before reading.
- **Never `Read` a session `.jsonl` transcript into context.** It is a raw
  conversation dump — extract only what you need via `jq`/`grep` piped to a file,
  or read the specific line range. (Was ~56% of 2026-08-26 measured token waste.)
- **Don't load what you won't cite.** Name the fact before pulling.
- **Collapse screenshots before VLM ingestion.** Use `arc-skills/skills/img-collapse/img-collapse` for screenshots >500px tall or with large uniform regions. Measure before/after; use collapsed if it saves tokens without losing detail.
- **Measure before you change.** Baseline + delta. State both.
- **Read tool output literally before hypothesizing.** Dates outside query
  window = nothing newer.
- **Subagents return distilled findings only** — conclusion + refs, under
  ~500 tokens.
- **Never print secret values.** Test presence only: `[ -n "$KEY" ] && echo set`.
  When forwarding env vars to subprocesses, echo the variable **name** only,
  never the value. Never log, echo, or write secret values to pane output,
  logs, beads issues, or tool results — names only.
- **Never bake operator identity into shared artifacts.** Generic roles only.
- **Install only first-party + self-authored.** Reject UGC plugins.
- **Configs and rules live in a git repo, symlinked into place.**
- **Subagent reports UNTRUSTED.** Verify claims against source. Check
  git-clean after fs-sharing.
- **/counsel over asking.** Decision fork → run /counsel, execute verdict.
  No AskUserQuestion.
- **Don't ask to do work.** Idle time > wasted effort. If a next step aligns
  with mission/instructions, take it — don't ask permission. Prefer reversible
  paths (git branch over rebase, trash over rm, new file over in-place edit,
  local over remote). Ask permission before irreversible actions: remote push
  of force/rebase, production deploy, destructive deletes, account/security
  changes, purchases. File a bead for work branches and follow-up explorations.
  Use DefendGates (DefendPlan, DefendMerge, etc.) to reject or defer low-value
  changes, not human confirmation prompts. "Do you want me to do X?" is a
  violation when X is reversible and obvious from context.
- **Defense steps require receipts.** Before any DefendGate (DefendPlan,
  DefendMerge, DefendDeploy, DefendConviction) proceeds, present clear
  Before → After evidence of the work and its improvements: diff summary,
  test results, metric deltas, screenshots for UI. No receipts = gate cannot
  clear, regardless of how good the work sounds.
- **Commit with identity from `~/vault/USER.md`** —
  `-c user.name -c user.email` per-commit.
- **Never present fabricated data as real (UM-0500).** Unmeasured = not passed.
- **Engineer for zero agent trust.** No output believed — checked. Distrust
  reduces cost at no quality loss.
- **Write lane (prose rule; structural gate pending — arc-director
  DESIGN.md invariant 7).** Only write files under `~/repos/**`, `/tmp/**`,
  `~/vault/ke/**`, `~/vault/director/**`, and the ledger (via bookie only).
  Any other path — new home dirs, `~/bin`, `~/agents`, other vault subtrees —
  requires captain approval before the first write. Check the target path
  before writing, not after.
- **Docs are earn-or-tmp (operator ruling 2026-08-27).** A persistent .md
  file may only be created if the human explicitly requested it or a skill
  defines it as output; everything else goes to /tmp and is trashed when its
  referencing task completes.
- **File layout: overlays nest, registries don't (operator ruling
  2026-08-27).** Context overlays (AGENTS.md, CONTEXT.md) are
  path-inherited — they apply to their folder + subfolders, nearest wins.
  Identity registries (root CHOICES.md; docs/adr/, docs/ontology/,
  docs/codemap/) are single-per-project, never nested; sub-scope via
  metadata fields inside the artifact. Repos with docs/ content carry a
  Map section in root AGENTS.md. Full rule: arc-skills
  docs/proposals/map-ontology.md §5d B.
- **Operator review goes to arc-webui as HTML (operator ruling
  2026-08-27).** Anything requiring captain review is presented as a
  self-contained HTML page under /review/<file> on arc-webui
  (http://<webui-host>:8080/review/<file>; artifacts in
  ~/vault/director/reviews/), linked from a human-gate ledger row
  (bookie create --kind task --type HITL). Never "open this file path".
- **Push early, push often.** Local divergence from origin creates merge
  conflicts and feature regression risk. Push feature branches to origin
  immediately, not at the end of development.
- **Check branches before building.** Before starting new development,
  check `gh branch list` and local worktrees for in-progress work that
  might overlap or collide. Never build in isolation from the team's
  active branches.
- **Monitoring backoff (deploy → stable).** All implementations and
  deployments use a monitoring backoff scheme. New deploys (rules, projects,
  features, services) are monitored heavily in short cycles. As positive
  functionality is proven, monitoring relaxes to longer cycles or smaller
  samples. Low usage or lack of evidence is NOT a backoff signal — only
  clear positive functionality triggers backoff. This applies to the tool
  stack, all repos, and all future products. Monitoring on stable products
  floors at a weekly grep audit, no less. Monitoring is only disabled for
  deprecated projects pending cleanup.
- **Confirm before changing policy, CHOICES, scope, or mission.** Never
  enact a change to GLOBAL-RULES.md, any CHOICES.md (mission/objectives/decisions),
  project scope, or a mission in ~/vault/missions.md without explicit
  operator approval first. For these constitutional changes, counsel provides
  arguments against only (if any) plus confirmation of understanding — not a
  full debate. The operator renders the final verdict. Other design and
  architecture decisions use full counsel with evidence as the basis for
  approval. Always present via arc-webui human-gate, wait for confirmation,
  then act.
- **Trust nothing without convincing evidence (UM-tier 1).** A claim,
  judgement, plan, request, or idea is a hypothesis until backed by evidence —
  from any source: the model itself, the user, the internet, whitepapers,
  other agents, prior sessions. Cite the evidence (file:line, URL, command
  output, commit sha) before treating it as basis for action. If asked to
  act on a claim without evidence, surface the gap and request evidence
  first; do not paper over it.
- **`+<tag>:` is annotation, not directive.** Lines of the form
  `+todo: …`, `+policy: …`, `+bd: …`, `+rule: …`, `+feedback: …`, or any
  other `+<tag>:` token are the operator's way of QUEUING a follow-up, not
  steering the current task. File a bead (`bd create` or `beads_create`),
  mark it queued for the appropriate session, then resume the in-flight
  task without distraction. Do NOT re-plan, re-scope, or pivot the current
  work to act on a `+<tag>:` line.
- **Heredr-spawned agents must use `bg_run` (non-blocking).** Long-running
  agent processes started in a herdr pane must be launched via `bg_run` so
  the spawning session is not blocked. Synchronous forks that hold the
  pane hostage are a violation; if you find yourself reaching for a
  blocking spawn, switch to `bg_run` or `bg_pi` first.
- **Match tool capabilities to task needs before invoking.** `bg_pi`
  spawns a pi sub-agent with a specific role (e.g. scout for read-only
  research, worker for code changes). For AFK write work (git commits,
  file changes, shell commands), use `bg_run` or `bg_run_pi_attested`.
  Check the tool description, not just its name.
- **No uncommitted code changes on main.** All code changes must go
  through: Worker (feature branch) → DefendMerge → Driver publishes to
  main → DefendPublish → Deploy → QA. Direct edits or commits on main/
  master are a violation. Use a feature branch or worktree, never edit
  main in place. Reject write/edit calls targeting main repo source files;
  redirect to Worker.
- **No long code blocks in bash commands.** Write code to files, then
  execute the files. Bash is for commands, not multi-line programs.
- **Director/Driver: bg_run for anything >30s.** Any subtask or action
  expected to exceed 30 seconds must be launched via `bg_run` (non-blocking).
  Synchronous execution of long-running work blocks the mission loop.

## Workbench Request Protocol

Private workspace agents (the operator's estate) requesting new tools or skill
improvements must file a GitHub issue at
https://github.com/a-canary/workbench/issues/new rather than forking or
developing locally. Issues must include: **what** is needed (specific
feature or fix), **why** it is needed (problem it solves), and **use case**
(concrete scenario where it applies). This keeps the workbench as the single
source of truth for shared tooling and prevents fork drift.

Local development is permitted only when: (a) a relevant workbench issue has
been filed and received no response after 48 hours, or (b) the tool is
private-specific (e.g., trading strategies, personal automations) and not
suitable for the shared workbench. In case (a), note the issue URL in your
local implementation for future reconciliation.
