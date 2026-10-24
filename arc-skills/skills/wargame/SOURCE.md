# Source

Method adapted from **"Do THIS Before You Lose Access to Fable 5"** by Mark
Kashef (YouTube, https://www.youtube.com/watch?v=nuwlyQXrADg), watched
2026-07-06.

Core idea lifted verbatim from the video: don't ask a capable model for a
*plan* (which assumes a linear, blue-sky path) — have it **wargame** the
mission, fighting it on paper move-by-move via the action → reaction →
counteraction loop, so any cheaper executor can run the pre-simulated
contingencies. Every move carries its expected observation, most-likely
failure, and countermove; every fork a trigger; every mission an abort
condition. Folder structure (tasks/, wargames/, success.md, ledger.md,
assumptions.md) is from the video's demo.

Adaptations for this environment:
- Output rooted at `<repo>/.wargame/` with a `main.md` index (video used a
  free-form `Fables last week/` folder + `wargames/*.markdown`).
- Wired to run standalone on a repo or as a follow-on to `/grill-me`.
- Executor-model tailoring routed through the local `claude-code-guide` agent.
