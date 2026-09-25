---
name: scheduler
description: Compute allocation and task scheduling for agent estates. Tracks available LLM compute (provider rate limits, local GPU throughput), rations compute per project by timebox or token caps, schedules driver ticks based on priority and availability. Provider- and hardware-aware.
---

# scheduler

Compute allocation and task scheduling for multi-repo agent estates. Decides **when** drivers run based on available compute, project priority, and rate limits.

**Architecture role:**
- **Director**: sets policy (priority, timebox, which projects matter)
- **Scheduler**: enforces (rate limits, subscription windows, GPU throughput, provider contention)
- **Driver**: executes within allocated window

## Invocation

```
/scheduler status           # show current allocation, queue, availability
/scheduler allocate <spec>  # allocate compute for a spec
/scheduler timebox <spec> <minutes>  # set timebox for a spec
/scheduler priority <spec> <0-4>     # set priority (0=highest)
/scheduler pause <project>  # pause all scheduling for a project
/scheduler resume <project> # resume scheduling for a project
```

## Compute tracking

### Provider rate limits
Track subscription windows per provider:
- Claude: 5-hour rolling window, token cap per window
- OpenAI: per-minute/per-day rate limits
- Vast/AI: wallet balance, per-instance limits
- Local (V100/P600): throughput in tokens/sec, concurrent request limit

### Allocation model
- Each project gets a **timebox** (minutes per day) or **token cap** (tokens per window)
- Priority determines queue order when contention exists
- Critical work (qa.failed critical-failure, security) bypasses timebox

## Scheduling algorithm

1. Query all active drivers for current state (idle, running, paused)
2. Check compute availability (provider windows, GPU load)
3. Sort waiting specs by priority (0=highest)
4. Allocate compute to highest-priority waiting spec
5. Wake the spec's driver (herdr pane send-keys or beads notify)
6. Track timebox consumption; pause driver when timebox expires

## Hardware awareness

- **V100**: primary local GPU, ~150 tok/s for 7B models, ~50 tok/s for 70B models
- **P600**: secondary local GPU, lower throughput, for parallel inference
- **Provider contention**: if multiple drivers use same provider, serialize or time-slice

**GPU allocation policy:**
- Open-source R&D work (fine-tuning, training) → V100/P600
- Private agent LLM calls → provider APIs (don't compete with R&D)
- If R&D is using V100, private agents wait or use provider fallback

## Beads integration

- Create scheduler beads issues for: allocation decisions, timebox expirations, contention events
- Use beads to communicate with directors (policy changes) and drivers (wake/pause)

## State

- `~/vault/director/scheduler.json` — current allocation state, timebox consumption, queue
- Updated every tick; persisted to survive restarts

## Fail-open

Scheduler is advisory + fail-open. If scheduler fails:
- Drivers proceed without timebox enforcement (run until complete or paused)
- Log the fail-open event
- Do not block work on scheduler failure
