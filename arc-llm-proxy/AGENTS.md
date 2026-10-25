# arc-llm-proxy — repo context

Global always-on rules live in GLOBAL-RULES.md (arc-skills root), loaded once per session via the user-level config symlink — not copied here.

## Repo rules

- Test gate is `npm test` (Node 25 runs .ts directly). The file list lives in package.json only — restating it here drifted twice already. Plain `tsc` is NOT the gate (pre-existing strict errors, no @types/node wired).
- Production runs from a separate checkout owned by a dedicated service user; dev checkouts are not production. Deployment is a separate deliberate step — never auto-sync.

## Map

- docs/ontology/ — project ontology registry: OVERVIEW.md (components, state, gaps) + router.md (auto-llm vocabulary, lifecycle, config). `surveyed_at_sha:` anchors each doc; drift-check against it.

