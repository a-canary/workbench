# ADR-0001: Role-gated pi extension — channel tools + tool_call guard

Date: 2026-08-24
Status: accepted
Decider: director (operator mandate: "constrain Director to ONLY communicate with
Captain, Drivers, Repair, Policy through the appropriate channels; keep its
context around high-level design, planning and delegation")

## Context

A pi session exposes the full toolset (bash, read, write, edit, …) to every
role. The Director's system prompt says "never execute work", but nothing in
the harness enforces it — a director pi session can run bash, edit files,
spawn workers, or message any agent. Zero-agent-trust doctrine: the tool
refuses, not the prompt asks.

The pi extension API (verified against
@earendil-works/pi-coding-agent dist/core/extensions/types.d.ts) provides
exactly the three primitives needed:

- `pi.registerTool(...)` — register channel tools the LLM can call.
- `pi.on("tool_call", h)` → `{block, reason, terminate}` — refuse any call.
- `SetActiveTools`/`GetActiveTools` — restrict the active toolset per session.

Roles already exist as herdr agents (director, repair, policy) + the factory
driver/worker lanes. `ARC_ROLE` is the role env var ADR-0015 (arc-agents)
standardizes for the ledger gate — this extension reuses it.

## Decision

New pi extension, repo `pi-channels` (self-authored a-canary pi-* pattern,
cloned into ~/.pi/agent/git/github.com/a-canary/ like pi-pipeliner).

### Role resolution

`ARC_ROLE` env var at session start. Unset → `ungated` (today's behavior,
fail-open for existing sessions; gated roles are opt-in by env).

### Director matrix (the mandate)

Allowed:
- `read`, `grep`, `glob`, `ls` — read-only file surface (design docs, maps,
  ledger via files, ke).
- `ledger_read` (registered) — wraps `ledger.ts --as director` for
  list / show / join-status / doctor / director-brief / await only.
- `captain` (registered) — post to webui feed / human-gate (the async
  operator channel).
- `driver` (registered) — ledger mutations: create / update / cancel / wake /
  repoint-blocked-by via `ledger.ts --as director` (delegation only).
- `repair` (registered) — `herdr agent prompt repair` (the DIRECTOR/repair tab).
- `policy` (registered) — `herdr agent prompt policy`.

Blocked (tool_call → `{block: true, reason}`):
- `bash`, `write`, `edit` — no execution, no direct file mutation.
- Any direct communication outside the four channels (herdr send-keys to
  other agents, discord writes, tmux control).

Refusal shape: one line naming the policy and the correct channel, e.g.
`blocked: director cannot use bash — delegate via the driver channel
(ledger create) or route to repair`. Refusals append to
`~/.cache/pi-channels/refusals.jsonl` (role, tool, reason, ts) for audit.

### Matrix as data

`src/role-tools.ts` — plain table `role → {allow: tool[], channels: {name →
handler}}`. Adding driver/worker/policy rows is a table edit (follow-up
rows; this ADR ships director + ungated only).

### Consequences

- Director context stays high-level by construction: it literally cannot
  reach a shell, so its turns spend tokens on design/planning/delegation.
- The four channels are the audit trail of every director communication.
- Ungated default means no existing session breaks on install; the director
  herdr agent's launch sets `ARC_ROLE=director`.
- Complements ADR-0015 (ledger verb gate): the extension is the outer gate
  (which tools exist), the ledger gate is the inner one (which verbs the
  tool may run). Both refuse independently.
