---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

**Size the question before delegating.** A single factual lookup — does X support Y, what version ships Z, one package/API detail — is answered by one direct call (a targeted WebFetch of the official page, an `npm view`/`gh api`/curl, a grep of the source), not by spawning agents. Try the one-call answer first; escalate to a background agent only when the question needs sustained multi-source reading. Fanning parallel subagent scouts at a one-fact question wastes their startup on work a single command would have finished — and when the scouts hit tooling errors you pay the failure plus the fallback you should have started with.

When the question genuinely needs the legwork, spin up a **background agent** to do the research, so you keep working while it reads.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
