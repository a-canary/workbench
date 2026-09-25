# select-models — Setup

**One-time install.** Run once after installing arc-skills; idempotent thereafter.

## What gets installed

Nothing is written until you invoke `/select-models` interactively. The actual side-effect (writing `arc-agents/config.json`) happens only when you run the skill and complete the interactive flow.

## Reversal

No files are written by SETUP.md itself. To undo the config written by the skill:

```bash
# remove the fast_alias/smart_alias entries from arc-agents/config.json
# then re-run /select-models to pick fresh models
```
