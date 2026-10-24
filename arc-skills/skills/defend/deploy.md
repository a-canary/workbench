# DefendDeploy — QA+visual passed → production deploy (counsel)

Fires after full QA **and** visual capture & analysis, before production
deploy: app version, YT video, X post, website content update. Production =
un-revocable in practice; this is the last model check before it crosses.

## Input to counsel (pipe all of it)

1. The artifact (or its full text / release notes + what changed).
2. QA report: dimensions covered, findings, coverage gaps.
3. **Visual evidence**: screenshots + VLM review report from webQA pipeline
   (Playwright → img-collapse → v100/local). Mandatory — gate fails without it.
4. The last human-approved prototype/reference, or a description of it — the
   drift lens needs something to compare against.
5. Audience + surface: who sees this, where, and how it can be taken down.

## Mandatory lenses

- **QA coverage gaps** — what did QA not look at that a user will?
- **Visual evidence review** — do the screenshots + VLM report confirm the UI
  renders correctly? Any visual bugs, CSS leaks, layout issues?
- **Audience perspectives** — how does a skeptical / hostile / naive reader
  experience this?
- **Controversy & safety scan** — claims that could be false, taken out of
  context, or read as harmful; anything inviting pile-on.
- **Rollback path** — if this lands wrong, what is the takedown/fix and how
  long does it take?
- **Drift since last human approval** — has any critical element (UI, claim,
  behavior) deviated functionally or visually from the prototype the human
  approved? If yes: **"refresh human approval"** is a valid and expected
  attack — the human reviewed an earlier state, not this one.

## Attack shapes (expected)

- "QA never covered <path>; a user will hit it in <scenario>."
- "Visual evidence shows <bug>; the VLM report confirms <issue>."
- "The headline claim is supported for <case A> but not <case B> — soften or prove."
- "Critical UI element X has deviated since the last human-reviewed prototype — refresh human approval before deploy."

## Verdict routing

`CLEAR | ATTACKS` → Driver, surfaced **verbatim** (no summarizing away).
ATTACKS block the deploy until resolved or overridden; override = ledger note
row (gate, attacks, why). "Refresh human approval" routes back to the user's
webui review with the drifted elements named.
