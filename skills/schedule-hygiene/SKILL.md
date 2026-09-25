---
name: schedule-hygiene
description: Pointer to the live hygiene rotation — the arc-agents hygiene-tick cron and the arc-skills nightly self-improve script. There is no installer to run.
---

# schedule-hygiene

Hygiene skills only help if they actually run. This is a pointer to the real
install — there is no separate installer to run.

The live rotation:

- **Cron**, not systemd. `crontab -l` shows the active entries.
- **`~/repos/arc-agents/bin/hygiene-tick.ts`** — runs 4x/day (`10,16,22,4`),
  picks one repo round-robin from `~/.config/arc/hygiene.yaml` (skill list +
  repo list + per-(repo,skill) cooldown), skips a repo with an open hygiene
  task (skip-not-stack), creates a ledger task. The factory dispatches it to
  a worker; nothing here calls `claude -p` directly.
- **`~/repos/arc-skills/bin/nightly-self-improve.sh`** — runs nightly at 03:00,
  drives `/dream` + `/token-waste` + `/gap-remediate` + `/adaptation-review`
  via `pi -p` (headless, one-shot, output to `~/.cache/arc-hygiene/`).

To change the schedule or rotation, edit the crontab or
`~/.config/arc/hygiene.yaml` directly — there is no `schedule-hygiene`
CLI or `install`/`uninstall` subcommand.
