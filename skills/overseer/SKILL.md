---
name: overseer
description: Hourly herdr pane observer. Runs on 15-min cron, detects blocked or stalled panes, nudges agents to resume, reports bugs to repo beads, escalates HITL issues to director, maintains pane hygiene. Never invoked directly by user.
---

# overseer

Automated herdr pane observer. Runs every 15 minutes via cron (`overseer.sh`). Observes all panes, detects issues, takes minimal-intervention actions.

## Cadence

15-minute cron: `*/15 * * * * bash <skill>/overseer.sh >> ~/vault/director/overseer.log 2>&1`

## Observation protocol

For each herdr pane:
1. Capture recent output (tail 50 lines)
2. Compare to previous state (diff stored in `/tmp/overseer-state/`)
3. Grep for error patterns and problem indicators
4. If pane claims to run a service: use `pwcheck` (arc-skills/overseer/lib) to probe actual endpoint health. If pwcheck unavailable, fall back to OS tools (`curl`, `ss`, `systemctl status`) — don't trust pane output text alone

## Problem detection

**Stalled pane:** Same tail output for 3+ consecutive checks
- Action: Nudge with `herdr pane send-keys <pane> enter`
- If still stalled after 2 nudges: Escalate to director via beads

**Error pattern:** grep for:
- `Error:` / `error:` / `ERROR`
- `failed` / `Failed` / `FAILED`
- `timeout` / `Timeout`
- `cannot` / `Cannot` / `Cannot find`
- `denied` / `Denied` / `permission`
- `panic` / `Panic`
- `segfault` / `core dump`

**Block indicators:** grep for:
- `waiting` / `Waiting`
- `blocked` / `Blocked`
- `need` / `Need` (human attention)
- `please` / `Please`

## Action hierarchy (minimal interruption)

1. **Nudge** — send enter or wake signal to stalled pane
2. **Notify** — send text to pane with relevant context
3. **Report to driver** — create bug ticket in central beads DB (`~/vault/director/.bd/`) with attribution fields (`repo:`, `assigned_to:`)
4. **Escalate** — create director beads issue for HITL attention if driver doesn't resolve within 2 hours

The overseer **never mutates task state directly** — it creates bug tickets and lets the driver assign and transition them.

## Bug routing

If errors indicate a bug in an owned service (e.g., arc-llm-proxy):
1. Create bug ticket in central beads DB (`~/vault/director/.bd/`) with attribution (`repo:`, `assigned_to:`, `created_by: overseer`)
2. Check if driver pane is running for that repo
3. If not running: spawn new driver pane with the bug ticket ID
4. Log the action in `~/vault/director/overseer.log`

**Block resolution protocol:**
1. Nudge stalled pane (up to 2 nudges)
2. If still stalled: create bug ticket in central DB, report to driver
3. If driver doesn't resolve within 2 hours: escalate to director via beads

## Hygiene

- Close panes that are idle for 2+ hours with no active tasks
- Report pane count and layout suggestions to director weekly
- Clean up `/tmp/overseer-state/` files older than 24h

## State storage

- `/tmp/overseer-state/<pane-id>.txt` — last observed output per pane
- `~/vault/director/overseer.log` — action log
- `~/vault/director/.bd/` — escalation beads

## Resilience

- Overseer and herdr.pane.repair run on **private-direct-llm (V100)** by default — allows them to detect and repair other tool stack issues as long as V100 is up.
- If V100 is down: use public llm-hosting driver to fix V100 using configured fallback model (e.g., `ali/qwen3.8-max`). Model names are configurable, never hardcoded.
- On dependency failure: attempt repair → restore from backup → recover data → escalate to director.
