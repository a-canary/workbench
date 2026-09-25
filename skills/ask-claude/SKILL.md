---
name: ask-claude
description: Thin cross-model Opus call — no tools, no context, one turn. stdin | claude -p --model opus --allowedTools "". Use for counsel escalation, or any second opinion, or any second opinion that must be disjoint from your model AND your context. Not for routine review — workhorse models do that.
---

# ask-claude — cross-model text-to-text transport

One Opus call. No tools. No shared context. One turn. The input you pipe in is
all it sees; the stdout it returns is all you get. Context isolation is the
point — never drop `--allowedTools ""`.

## Invocation

```sh
: "${CLAUDE_CODE_OAUTH_TOKEN:=$(pass show api/claude/oauth-token)}"
export CLAUDE_CODE_OAUTH_TOKEN
<artifact + attack frame> | claude -p --model opus --max-turns 1 --allowedTools ""
```

- **Input**: the full text of the artifact under attack, plus the attack frame
  (gate rubric from `defend/`, or the counsel report). If the artifact is a
  diff, pipe the diff file contents — Opus gets text, not tool access.
- **Output**: a verdict in the contract shape below. If the shape is wrong,
  re-run once with "respond strictly in this shape: …". Never parse prose
  hopelessly — enforce the contract.
- **Token**: pass `api/claude/oauth-token` (1-yr OAuth). Never print it.
- **Model tier per gate**: DefendPlan = opus, DefendMerge = workhorse (see
  defend/merge.md — it is /hard-merge, no Opus), DefendDeploy = counsel panel.

## Verdict contract (all callers)

```
CLEAR | ATTACKS
attacks: ranked list, severe-first. Each item:
  - the finding (one line, cite the artifact location)
  - what would satisfy it (evidence X / test Y / change Z)
  - lens: <rubric lens name> | free
```

Overrides of ATTACKS are logged as ledger `event`s, never silent — naming the
gate, the attacks overridden, and why. A CLEAR from Opus is still an
untrusted subagent report — verify checkable claims against source before
acting.

## Cost rule

Opus is spent only at named junctions (defend gates, counsel escalation).
Routine review, planning ticks, and worker lanes run on the workhorse model.
If you are about to call ask-claude outside a named junction, stop and check
whether the workhorse tier is proportionate.
