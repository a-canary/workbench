# Source

Lifted from **aaron/vast-warmpool** on 2026-06-11.

- Author: aaron (same maintainer as arc-skills)
- License: MIT (project license)
- Upstream: https://github.com/a-canary/vast-warmpool (`skills/vast-cli/SKILL.md`)

The original skill was authored against a specific `~/repos/arc-agents/bin/vast-lease.ts` path. It has been genericized for arc-skills: the lease reference is now a generic "your `vast-lease` helper" and the warmpool reference is a generic "your warmpool daemon". Verbs, gotchas, and lifecycle order are preserved verbatim.
