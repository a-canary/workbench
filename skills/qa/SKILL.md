---
name: qa
description: Spawns a QA agent to test a feature or fix from a user perspective — screenshots, friction, content truthfulness, functional correctness, presentation. Use to verify a completed task before closing a gap, or when batched user feedback crosses the verification threshold. Do NOT use for code review — use /task's adversarial review instead.
---

# qa

User-perspective verification agent. Tests what a user would see and feel, not what the code says it does. Produces structured feedback that feeds the director's next tick.

## Invocation

```
/qa "<target description>" [--ref evt_id] [--version v1.2.0] [--feedback-batch fb_01,fb_02]
```

QA findings written to `.arc/director/qa/<ref>.md`. Screenshots to `.arc/director/qa/screenshots/`.

- `--ref` — links QA result back to the `task.completed` event being verified
- `--version` — pins the build/version under test (required for reproducibility)
- `--feedback-batch` — when dispatched from batched user feedback, lists source `user.feedback` event IDs

**Before any public release** (app version, YT video, X post, website content):
QA pass + human webui review are not the last step — run **DefendDeploy**
(`defend` skill, release.md; Opus via ask-claude) after both, before the Driver
deploys. Its drift lens can force a refreshed human approval.

## QA dimensions

Assess each dimension that applies. Flag `critical-failure` or `security` findings immediately — these trigger the director's budget bypass.

| Dimension | What to check | Bypass trigger |
|---|---|---|
| **functional** | Does it do what the spec says? Happy path + edge cases | — |
| **presentation** | Layout, contrast, spacing, mobile, loading states | — |
| **friction** | Steps to complete a task — unnecessary or confusing steps? | — |
| **content** | Copy clarity, tone, completeness | — |
| **truthfulness** | Claims, stats, labels — accurate? No hallucinated data? | — |
| **regression** | Did this break anything adjacent? | — |
| **critical-failure** | Functional breakage affecting users in production | budget bypass |
| **security** | Auth bypass, data exposure, injection surface | budget bypass |

Screenshot every finding. Path goes in evidence or reproduction.

## Annotation format for findings

```jsonl
{"feature":"auth/login","version":"2.1.0","resource":"/login","dimension":"friction","description":"Submit button says 'Continue' but action is final — misleading","screenshot":"qa/screenshots/login-submit-2.1.0.png"}
```

Use exact `resource` paths and `version` strings — makes batched user feedback falsifiable against QA findings.

## Output events

Pass:
```jsonl
{"type":"qa.passed","status":"resolved","ref":"evt_01","evidence":[{"path":"qa/screenshots/login-happy-2.1.0.png","description":"happy path in 3 steps, no friction found"}]}
```

When you were dispatched to verify a **deployed live surface** (post-merge, per hard-merge §6 — not the pre-merge diff), add `"phase":"post-deploy"` to the emitted `qa.passed`. That field is what tells the director this is the live-surface result that closes a production gap, distinct from the pre-deploy diff pass. Omit it for any pre-deploy QA.

Fail:
```jsonl
{"type":"qa.failed","status":"resolved","ref":"evt_01","dimension":"critical-failure","reproduction":[{"path":"qa/screenshots/login-broken-2.1.0.png","description":"submit hangs on mobile — reproduced on iOS Safari and Chrome Android"}]}
```

## Trust rules (enforced by director)

- `qa.passed` without `evidence` paths → rejected by director
- `qa.failed` without `reproduction` paths → rejected by director
- `qa.failed` with `dimension: critical-failure` or `dimension: security` → director bypasses weekly token budget for the incident
- When dispatched from `--feedback-batch`: must reference all batch IDs so director can close those feedback events if fix confirmed

## What QA does NOT own

- Code fixes (surfaces findings only, never edits code)
- Adversarial logic review (owned by `/task`)
- Gap analysis or task delegation (owned by `/director`)
- Token budget policy (owned by `/director` bindings)
