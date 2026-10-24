# feedback -- reference

Loaded on demand. Core invocation lives in SKILL.md.

## What to provide

| Flag | Purpose | Example |
|---|---|---|
| `--feature` | Repo path or feature name | `auth/login`, `dashboard/charts` |
| `--version` | Build or release version under test | `2.1.0`, `main@a3f9c1` |
| `--resource` | Exact URL path, screen name, or file | `/login`, `SettingsScreen`, `report.pdf` |
| `--dimension` | QA dimension hint | `friction`, `truthfulness`, `security`, `critical-failure` |

More hints = more precise batching = faster director response. `critical-failure` and `security` dimensions trigger immediate `/qa` dispatch regardless of batch count.

## Output entry

Written to feedback sink declared in `AGENTS.md` (`feedback-sink` binding). Default: `.arc/feedback.jsonl`.

```jsonl
{"id":"fb_01","type":"user.feedback","status":"open","ts":1751235100,"description":"submit button unresponsive on mobile","feature":"auth/login","version":"2.1.0","resource":"/login","dimension":"friction"}
```

Omitted optional fields are excluded from the entry -- director still batches on what's present.

## Bypass triggers

If `--dimension critical-failure` or `--dimension security` is provided, the entry is written with `priority: bypass`. Director dispatches `/qa` immediately on the next tick, bypassing the weekly token budget for the incident.

## Feedback sink binding

Declared in `AGENTS.md`:

```md
feedback-sink: jsonl              # .arc/feedback.jsonl (default)
feedback-sink: https://api.example.com/feedback   # POST to API endpoint
feedback-sink: <skill-name>       # custom skill handles injection
```

## What feedback does NOT own

- QA execution (owned by `/qa`)
- Batching logic and thresholds (owned by `/director`)
- Bug fixing (director dispatches `/task` after QA confirms)
