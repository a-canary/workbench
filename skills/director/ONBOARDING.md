# director — first-run onboarding

Companion to `SKILL.md`. Owns the **one-time first-run procedure**. Load this
only when the boot sequence detects an unconfigured parent repo — steady-state
ticks never need it.

Triggers when the parent repo has no `AGENTS.md`, or has one with no `## Director
bindings` section. Runs once, before the normal boot sequence, then falls through
into it.

1. Run the discovery script — deterministic, no guessing:
   ```
   bash skills/director/scripts/discover-setup.sh
   ```
   Prints `repo-root`, `agents-md-exists`, `director-bindings-exist`,
   `git-remote`, `arc-agents-available`, `arc-agents-config`, `vault-path`,
   `directors-registry`, `repo-already-registered` — each `<key>\t<value>`,
   `-` for absent.

2. Ask the user (one batched set of questions), pre-filling suggestions from
   step 1's output — never silently apply a suggestion:
   - **Which repo should this Director manage?** Default: `repo-root` from
     discovery. If `repo-already-registered: yes`, warn and ask whether to
     reconfigure the existing entry or pick a different repo.
   - **Where should Director's memory/state live?** Default: `.arc/director`
     (in-repo, git-tracked, zero deps). Offer `vault-path` from discovery as
     an alternative only if it isn't `-`. A custom path is always allowed.
   - **Weekly token cap for this repo?** Default: `500k`. Mention the
     bypass list (`critical-failure`, `security`) always applies regardless
     of cap.
   - **Backstop tick cadence, in hours?** Default: `12`. Explain: director is
     event-driven and sleeps between events; this is only the dead-man's-switch
     interval, not a poll loop.
   - **Each remaining binding** (`event-bus`, `task-delegation`, `workspace`,
     `on-task-verified`, `todo-list`, `feedback-sink`, `planning-target`,
     `model`, `scheduler.mode`): suggest the flat-file/harness-native default for each
     (see [BINDINGS.md](BINDINGS.md)), but if `arc-agents-available: yes`,
     also surface the arc-agents-backed alternative as a selectable option
     (e.g. `task-delegation: arc-agents`, `scheduler.mode: arc-agents`) rather
     than silently preferring it — the habitual default always wins unless
     the user opts in.

3. Write `AGENTS.md` at the target repo root from
   `skills/director/AGENTS.md.template`, filling in the answers. If
   `AGENTS.md` already exists (just missing the bindings section), append the
   `## Director bindings` block rather than overwriting the file.

4. Register the repo in `~/.config/arc/directors.json` (create if absent):
   ```jsonc
   {
     "directors": {
       "<parent-repo-root>": {
         "memory": ".arc/director",         // resolved path from step 2
         "manages": ["<parent-repo-root>"], // this repo + any delegation targets added later
         "registered_at": "<ISO date>"
       }
     }
   }
   ```
   One entry per parent repo. `manages` starts as just the parent repo itself —
   additional managed repos are appended here only when this repo's `AGENTS.md`
   later declares them as delegation targets, not during onboarding.

5. Fall through into the normal boot sequence in `SKILL.md` — onboarding does not
   itself confirm or run a tick; boot step 4's confirmation gate still applies.
