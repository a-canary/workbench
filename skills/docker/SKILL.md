---
name: docker
description: Docker discipline for mission automations — own-stack only, shared-host etiquette. Use when building, running, or managing Docker containers/compose stacks.
disable-model-invocation: true
---

# Docker

## Own-stack only

Operate ONLY containers/compose files belonging to your own repo (per-repo allow-rules, name-scoped). Never touch another stack — no `docker system prune`, no blanket restarts, no killing containers you didn't start. Cross-stack action needs /counsel.

## Shared-host etiquette

- Check disk (>10G free) + load before builds
- One heavy build/pull at a time
- GPU single-tenant (`nvidia-smi` before claiming)
- Never bind another service's port (check `ss -ltn` first)
- Under capacity contention, yield by axis rank (`~/vault/missions.md` ranking)
