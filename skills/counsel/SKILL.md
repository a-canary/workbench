---
name: counsel
description: Adversarial counsel session with 5 experts on 5 axes (advocate | critic | pragmatist | historian | futurist) across 2 rounds, synthesized into one report or course of action. Use when the user says "counsel", "get expert advice", "adversarial review", or wants multiple perspectives on a decision.
---

# Counsel — Adversarial Expert Panel

Simulates an adversarial conversation between 5 experts along **5 unique axes**
to stress-test a decision, plan, or technical approach. Each axis is a
distinct lens — none of them duplicates another. If a panel can't keep the
5 distinct, reduce to fewer axes rather than collapse two.

## The 5 axes

| Axis | Lens | Asks |
| --- | --- | --- |
| **advocate** | Steelman — argue FOR | What's the strongest possible case for this proposal? What would its best advocate say? |
| **critic** | Argue AGAINST | What flaws, failure modes, hidden costs, weak assumptions exist? What would a hostile reviewer find? |
| **pragmatist** | Implementation reality (now) | Cost, time, complexity, dependencies. What does day-to-day operation look like? |
| **historian** | Past precedents | What worked / didn't before? What does ke or the literature say about analogous decisions? |
| **futurist** | Long-term implications | Second-order effects, scaling, lock-in. What does this commit us to in 6 months / 2 years? |

The axes are orthogonal: advocate vs critic = direction; pragmatist vs futurist = time horizon; historian = precedent vs the proposal itself. No axis is "find weaknesses" twice, and no axis is "think long-term" twice.

## Workflow

### Round 1: Independent Investigation + Opening Arguments

1. **Spawn 5 expert sub-sessions** in parallel — one per axis above.
   Each session takes the role assigned; none may overlap into another axis.

2. **Each expert runs their own research:**
   ```
   ke:recall <topic>
   read relevant files
   run queries as needed
   ```

3. **Each expert presents opening argument** (3-5 sentences):
   - Their domain's perspective
   - Key concerns or opportunities
   - Preliminary verdict

### Round 2: Rebuttal + Refinement

4. **Cross-examination round** — each expert:
   - Responds to the weakest argument from another expert
   - Updates their position based on new information
   - Presents refined stance

5. **Final arguments** (2-3 sentences each)

### Synthesis

6. **Generate report:**
   ```markdown
   ## Counsel Report: [Topic]

   ### Consensus Points (N/5 agree)
   - ...

   ### Key Disagreements
   - ...

   ### Strongest Arguments
   - ...

   ### Recommended Course of Action
   1. ...
   2. ...
   3. ...

   ### Dissenting Views
   - ...
   ```

## Implementation Notes

- Use `claude-afk` or ledger child tasks for each expert sub-session
- Experts can read files and run ke:recall within their session
- Round 2 prompt includes all Round 1 arguments for cross-examination
- Final synthesis prioritizes actionable recommendations over academic debate

## Constraints

- 2 rounds maximum (avoids analysis paralysis)
- Each argument limited to 5 sentences max (forces clarity)
- Report must include concrete next steps

## Why counsel, not a single reviewer

Counsel **bypasses the self-approve / self-judgment limitation** by adversarially
reviewing from multiple independent perspectives. Per AGENTS.md: a model
scoring against its own rubric proves consistency, not quality — and a single
reviewer reading the same author's reasoning from a shared context is still
self-approval in disguise. The 5 axes (advocate / critic / pragmatist /
historian / futurist) are deliberately orthogonal so each argues from a
distinct lens, with critic-vs-advocate and pragmatist-vs-futurist balancing
each other. When `/hard-merge` (or any merge-on-clear gate) needs judgment
that a single reviewer's CLEAR can't carry — non-small blast radius, disputed
verdict on a production surface, or a long-running agent needing a second
opinion on its own work — counsel is the replacement for that single
reviewer. Same trigger as /hard-merge's §4 panel escalation; same 5-expert
shape; same outcome (judgment breadth + audit trail, NOT a mechanical
unlock — a merge classifier still sees only the diff and may block).

## Opus escalation — cross-model attack/verdict

Any agent or user may invoke counsel when facing a **very complex problem** or a
**repeating blockage**. When either applies, do not stop at the panel:

1. Collect fresh data from many angles first — the panel rounds are the debate;
   if the question is under-evidenced, gather evidence before debating it.
2. Pipe the full report + the raw round-1/round-2 arguments to Opus via the
   **ask-claude** skill (no tools, no context, one turn):

   ```sh
   : "${CLAUDE_CODE_OAUTH_TOKEN:=$(pass show api/claude/oauth-token)}"; export CLAUDE_CODE_OAUTH_TOKEN
   cat /tmp/counsel-<slug>.md | claude -p --model opus --max-turns 1 --allowedTools "" \
     "You are a cross-model attacker. Attack this counsel report: find the load-bearing assumption the panel missed, the strongest counter to the recommended action, and any false consensus (experts agreeing because the frame was wrong, not because the answer is right). Respond in the ask-claude verdict contract: CLEAR | ATTACKS, ranked, each attack with what would satisfy it."
   ```

3. Append Opus's output as `### Cross-Model Attack (Opus)` at the end of the
   report. Where Opus and panel consensus conflict, **flag the conflict
   explicitly** — do not silently let either side win. Opus is still an
   untrusted report: verify checkable claims before acting.

Skip this step for routine decisions — five same-model experts are proportionate
there; Opus is spent on complexity/blockage, per the ask-claude cost rule.
