# director — bindings & reference

Companion to `SKILL.md`. Owns the **reference material**: the bindings block declared in `AGENTS.md`, each binding's options, the `.arc/` working-file layout, and the event-bus schema. `SKILL.md` owns the operator procedure (invocation, boot, loop, states); `ONBOARDING.md` owns the one-time first-run setup.

Read this file when you need to know what a binding accepts, where state lives, or what shape events take. Read `SKILL.md` when you need to know what director does on each tick.

## Bindings

Declared in `AGENTS.md`. Director prompts on first boot for any missing binding, writes the answer back.

```md
## Director bindings
event-bus: jsonl              # jsonl | db | <skill-name>
task-delegation: native       # native (harness tool) | arc-agents | <skill-name>
workspace: worktree           # worktree | treehouse | <skill-name>
on-task-verified: merge       # merge | draft-pr | <skill-name>; production surface: /hard-merge pre-merge, then /qa post-deploy
todo-list: native             # native | arc-agents | <skill-name>
feedback-sink: jsonl          # jsonl | <api-endpoint> | <skill-name>
planning-target: prd-file     # prd-file | arc-agents-ledger | kanban | <skill-name>
model:
  director: fable > opus > sonnet  # director's own self-spawned --afk tick; first tier available wins
  director-effort: max
  worker: sonnet               # every task-delegation dispatch
  worker-effort: max
  env:
    DISABLE_INTERLEAVED_THINKING: "true"
scheduler:
  mode: cron                  # cron (self-installed backstop) | arc-agents | <skill-name>
  backstop-hours: 12          # idle-backstop tick cadence; lower = more frequent wake, higher token floor
budget:
  weekly: 500k                # tokens/week per repo; resets Monday 00:00 UTC
  bypass:
    - critical-failure        # qa.failed with dimension: critical-failure
    - security                # qa.failed with dimension: security
capacity: none                # none | capacity (shared cross-director provider headroom; advisory, fail-open)
```

### `planning-target`

How director plans the *next* unit of work, independent of how `/task` executes it.

- **`prd-file`** (default) — one `PRD.md` at repo root, addressing only the single
  most important open gap. On completion, `/director` replaces it with the next
  PRD rather than accumulating a backlog file. Flat-file, sequential, zero deps.
- **`arc-agents-ledger`** — delegates planning to arc-agents' `kind=prd` ledger
  queue (`bin/plan.ts` mints a PRD row at the human-approval gate; arc-agents'
  `agent=director` profile claims it, runs intake, decomposes into ledger task
  rows). Useful when a repo already runs arc-agents and wants a queryable,
  multi-PRD-in-flight backlog instead of one-at-a-time. This is arc-agents'
  pre-existing PRD-intake pathway — not `/director`'s own interviewer role,
  which `/director`'s non-AFK mode (grilling + research, pause/steer/resume)
  already covers standalone.
- **`kanban`** / `<skill-name>` — any other planning surface a binding wires up.

### `capacity`

Shared cross-director provider arbitration. `budget` caps what THIS repo may
spend; `capacity` answers whether the *shared* provider (one Claude 5h window,
one MiniMax weekly cap, one vast wallet) has headroom right now. **Advisory +
fail-open, always**: any capacity error → proceed as if unbound and emit
`capacity.failopen`; a capacity failure must never block a dispatch.

- **`none`** (default) — skip entirely.
- **`capacity`** — before each dispatch run
  `bun ~/.claude/skills/capacity/capacity.ts route --provider <p> --lane <tier>`
  (lane: bypass-trigger work = `critical`, exploratory = `research`, else
  `standard`). Verdict `run` → dispatch; `park` → re-queue the task with a gap
  note + emit `capacity.parked` (carry `vast_stop` through); `escalate`
  (critical only) → dispatch anyway on the best alternative provider, note the
  constraint. After every provider response, `capacity.ts record --provider <p>
  --tokens <n> --status ok|429`. Contract + estimator details:
  `skills/capacity/SKILL.md`.

### `model`

What tier and reasoning effort each self-spawned invocation runs at, and a shared
env var applied to both. Only governs invocations `/director` spawns itself — a
foreground `/director` run started interactively inherits whatever model the
user's session is already on; this binding does not override that.

- **`director`** — priority-ordered fallback list (default `fable > opus > sonnet`)
  for the `--afk` cron tick: use the first tier the harness actually has.
- **`worker`** — single tier (default `sonnet`) for every `task-delegation`
  dispatch (`/task`, its adversarial-review step, `/qa`, and any other entry in
  `AGENTS.md`'s `## Worker agents` table).
- **`director-effort` / `worker-effort`** — reasoning effort per tier (default
  `max` for both).
- **`env`** — env vars exported before every self-spawned invocation, e.g.
  `DISABLE_INTERLEAVED_THINKING: "true"`.

Resolved into the actual command depending on `scheduler.mode` /
`task-delegation`:
- `native` harness tool (Agent/Task) — pass `model` (and effort, if the harness
  tool exposes it) as call params; export `env` in the spawning process.
- `cron` self-install / worker CLI commands — prepend `env` vars, then
  `--model <tier> --effort <level>`, e.g.
  `DISABLE_INTERLEAVED_THINKING=true claude --model sonnet --effort max -p "..."`.
- `arc-agents` backend — map `director`/`worker` onto its `smart_alias`/
  `fast_alias` exec-CLI aliases (see `select-models` skill) instead of
  hardcoding a `claude --model` string; `env` still applies at the shell level.

### `scheduler`

How `/director` gets re-invoked to drive the AFK loop forward.

- **`cron`** (default) — `/director` is self-sufficient: on first `--afk` boot it
  installs its own feedback watcher and a cron entry, cadence set by
  `scheduler.backstop-hours` (default 12hr — NOT 1–2hr; don't conflate with
  `ScheduleWakeup`, whose per-call delay clamps to 1hr max and cannot implement a
  12hr backstop, so it must be a real cron entry). Lower cadence catches stalls
  sooner at a higher idle-tick token floor; higher is cheaper but widens the
  worst-case silent-stall window. The backstop tick runs the same loop as any
  other — nothing to do → straight back to idle. It re-runs
  `<harness> /director <repo-root> --afk` using the `model.director` binding
  above, e.g. `DISABLE_INTERLEAVED_THINKING=true <harness> --model fable --effort max
  /director <repo-root> --afk` (falling back to `opus`, then `sonnet`, per the
  binding's priority list). Each invocation reads `.arc/director/`
  state and resumes where it left off — no daemon, no external scheduler.
- **`arc-agents`** — if installed, arc-agents' factory can schedule and execute
  the tick instead of a bare cron entry (its existing supervisor/reaper loop
  substitutes for the self-installed cron), and can dispatch through its own
  CLI-agent failover group (`fast`/`smart` alias chains) instead of a single
  fixed harness — useful when a repo wants cross-provider/cross-model retry on
  a stuck tick rather than depending on one harness's own background-agent or
  cron mechanism. Optional, not required — see arc-agents
  [ADR-0012 addendum 2](https://github.com/a-canary/arc-agents/blob/main/docs/adr/0012-director-agent-axi.md).

### `task-delegation`

How a worker dispatches a subagent. Binding name is fixed; the value selects which dispatch layer runs.

- **`native`** (default) — the host harness's own tool. Each harness exposes its
  own name and shape (Claude Code's Agent/Task, pi's tool surface, etc.); the
  binding value is the literal the harness accepts. Sync, in-process, full tool
  surface; runs in the harness's auth context. Best when the host has a working
  tool-using agent (Claude OAuth, pi on a non-capped provider, etc.).
- **`arc-agents`** — bookie ledger dispatch via `ledger create --kind task
  --type ...`; the factory's scheduled tick claims and runs the row through
  `worker-shell.sh` (one tmux pane per worker, full tools, observable). Async,
  budgeted, ledger-tracked. Use when the host harness auth is capped, when the
  work is deferrable, or when audit-trail via the ledger matters more than
  wall-clock latency.
- **`<skill-name>`** — any other dispatch surface a binding wires up. Pick a
  skill that already exists on the host and accepts a prompt + tool surface;
  document the exact token in a sub-section here. Reserved for hosts where
  neither `native` nor `arc-agents` is the right shape.

Resolution at runtime: a worker reads its repo's `task-delegation:` binding at
load time, picks the matching dispatcher, and runs there. No global fallback
— a worker without a declared binding gets `native`.

## `.arc/` layout

`PRD.md` itself lives at the parent repo's root, not under `.arc/` — it's a
human-readable planning artifact (`planning-target: prd-file`, the default),
replaced wholesale when its gap closes. Everything under `.arc/` is director's
own working state, derived from whatever the current PRD says.

```
.arc/
  events.jsonl              # IPC event bus (gitignored by default)
  feedback.jsonl            # user feedback sink (git-tracked)
  director/                 # director working files (git-tracked)
    gaps.md                 # current gap list + state header (rewritten each tick)
    inflight.md             # tasks assigned, not yet completed (rewritten each tick)
    blocked.md              # stuck tasks with reason (rewritten each tick)
    director.paused         # sentinel; presence = paused (deleted on resume)
    specs/<slice>.md        # written by /task before TDD loop
    qa/<ref>.md             # written by /qa after verification
  local-dev-dash/           # webui contract (git-tracked; director generates each tick)
    main.html               # entry point — renders mission, gaps, metrics, lanes
    mission.md              # restated objective
    metrics.svg             # KPI chart toward mission completion
    lanes.json              # roadmap lanes (gaps → tasks → done)
```

`local-dev-dash/main.html` is the dashboard contract. Webui iframes or links to it; the repo
owns what's inside. Inspectable with a plain browser — no server required. Director regenerates
it at the end of every tick from its working files. arc-webui sidebar chat annotates against
`main.html` anchors and writes annotations to the `feedback-sink` binding — no ledger touch.

## Event schema

```jsonl
{"id":"evt_01","type":"task.assigned","status":"open","ts":1751234567,"slice":"auth/login","acceptance":"all edge cases green","worker_id":"tdd-agent"}
{"id":"evt_02","type":"task.completed","status":"resolved","ts":1751234890,"ref":"evt_01","worker_id":"tdd-agent","evidence":[{"path":"tests/auth.test.ts","description":"12/12 green"},{"path":"src/auth/login.ts","description":"matches spec"}]}
{"id":"evt_03","type":"qa.passed","status":"resolved","ts":1751235000,"ref":"evt_02","evidence":[{"path":"qa/screenshots/login-2.1.0.png","description":"happy path, no friction"}]}
{"id":"evt_04","type":"qa.passed","status":"resolved","ts":1751235400,"ref":"evt_02","phase":"post-deploy","evidence":[{"path":"qa/screenshots/login-live-2.1.0.png","description":"live surface, deployed result verified"}]}
{"id":"fb_01","type":"user.feedback","status":"open","ts":1751235100,"feature":"auth/login","version":"2.1.0","resource":"/login","description":"submit button unresponsive on mobile"}
```

`phase` is optional and appears only on a `qa.passed` from a **post-deploy** live-surface run (see `SKILL.md` director loop + `hard-merge` §6). Absent = the pre-deploy diff-QA pass; `"post-deploy"` = the live-surface pass that actually closes a production gap. The two are otherwise identical events, so the field is what makes the director's two `qa.passed` branches mechanically selectable.