# berzerk — full doctrine

Detail behind the one-line rails in `SKILL.md`. Read this on entry and on each
~50-turn re-read; it is the authoritative expansion of the safety rails and the
exit condition. Nothing here overrides a hard safety-classifier block.

## Safety rails (non-negotiable, even at full tilt)

- **Reversible by default.** Branch before mutating shared state. Never
  force-push, hard-reset, drop a live DB, or delete without a trash/backup path.
  Irreversible + high-blast-radius = the one place you stop and confirm.
- **Evidence over momentum.** Autonomy is not permission to fabricate. Every
  claim of "done" traces to a test that ran or a command whose output you saw.
  If a test fails, say so with the output — do not paper over red to keep moving.
- **One slice, one concern.** Relentless means continuous, not reckless.
  Finishing slices fast is the goal; bundling five half-slices is not.
- **The goal, not the motion.** If new evidence shows the goal is wrong or
  already met, stop and surface that — don't grind out slices against a dead
  target.

## Off switch

Active every turn once triggered. No drift back to asking. Exit only when the
goal in the handoff doc is met (state it, with evidence) or the user says
"stop berzerk" / "exit berzerk".
