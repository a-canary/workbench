---
name: feedback
description: Injects structured user feedback into a repo's feedback sink (.arc/feedback.jsonl by default). Use when a developer or end user wants to report friction, a bug, a content problem, or a feature gap — and have it feed the director's next gap-analysis tick. All args except description are optional hints that improve batching quality.
---

# feedback

Feedback injection point. Writes one structured entry to the repo's feedback sink. Director batches entries by `(feature, version, resource)` and dispatches `/qa` when count crosses threshold.

## Invocation

```
/feedback "<description>" [--feature auth/login] [--version 2.1.0] [--resource /login] [--dimension friction]
```

Bare description is valid; all flags are optional batching hints (`--feature`, `--version`, `--resource`, `--dimension`) — director infers the rest. More hints = tighter batching. `--dimension critical-failure` or `security` writes `priority: bypass` -> director dispatches `/qa` immediately next tick, bypassing the weekly budget.

Writes one entry to the sink declared in `AGENTS.md` (`feedback-sink` binding; default `.arc/feedback.jsonl`); omitted fields excluded. Does NOT own QA execution (`/qa`), batching thresholds (`/director`), or fixing (`/task`).

For the field reference, entry schema, and sink-binding options, see [reference.md](reference.md).
