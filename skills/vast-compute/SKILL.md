---
name: vast-compute
description: Rules for reserving and running jobs on shared vast.ai GPU boxes. Use BEFORE reserving, starting, SSHing into, or running any job on a vast.ai instance — covers the mandatory local smoke test, the cooperative lease, and keep-warm batching.
---

# vast-compute

Situational rules for shared vast.ai GPU boxes. Read before touching a remote box.

## Smoke-test before remote

Prove the job runs with a **local smoke test (≤30s wall-clock)** before reserving or running on any vast.ai box. The smoke test proves the job actually runs before you pay for a remote box.

- Smoke passes → remote use is **auto-approved** (no per-use SSH approval).
- Smoke fails or can't finish in 30s → fall back to asking for explicit approval.

## Lease before any job

Shared boxes are used by multiple agents at once. Acquire a cooperative lease first; release when done:

```
bun ~/repos/arc-agents/bin/vast-lease.ts <acquire|release|renew|status|queue|steal>
```

- State lives in `~/vault/vast/<instance>/`.
- `acquire --wait` blocks FIFO until the box is free.
- Renew long jobs (default TTL 3600s) so they don't look abandoned.
- Never start on a box held by another holder without `steal` (last resort — it logs the eviction).

## Keep boxes hot

High cold-start tax. Queue jobs and keep the instance warm — never spin up per-job. `vast-warmpool.ts` + its systemd timer handles queue → start → keep-warm 15m → stop.
