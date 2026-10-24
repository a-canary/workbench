# Proposal: `map-ontology` skill

Status: proposal — pending captain decision on §6 open questions.
Date: 2026-08-25. Author: director (research + design only; execution goes to ledger).

## 1. What it is

A skill that surveys a scope and produces an **ontology map**: `OVERVIEW.md` + topic files, in human language, with evidence pointers per claim — plus a findings pass that tickets overlaps/conflicts/gaps to the ledger.

It codifies what the 2026-08-24 harness survey did ad hoc (session arc-director 13:57Z):
one request → 8 files in `~/vault/ontology/` + 11 findings ticketed. That session was the pilot; it worked, and the operator's placement policy came out of it:

> project-scoped map → lives in the repo; meta (cross-repo) map → lives in `~/vault/`.

The skill makes that repeatable at both scopes and adds the missing piece the pilot lacked: a **staleness regime** (§5).

## 2. References (researched 2026-08-25)

Two talks supplied the core framing; the rest anchor specific design choices. Fetch-verified this session: GraphRAG, Graphiti/Zep, Aider.

| # | Reference | Takeaway | Answers |
|---|-----------|----------|---------|
| 1 | Frank Coyle (UC Berkeley), "Why Agentic Systems Need Ontologies", AI Engineer conf 2026-07-23 — youtube Sir59K8ZDPU | Ontology = guardrail around a probabilistic model (neurosymbolic). Build top-down (expert) or bottom-up (usage); reuse existing taxonomies; validate agent tool outputs against the ontology — "Pydantic at the door, ontology at the ledger". Errors English can't catch: duplicate refunds, wrong-recipient payouts, invented enum values. | Why an ontology earns its place for agents; validator pattern for §5 layer 2 |
| 2 | Emil Eifrem (Neo4j), "Thinner Agents on a Smarter Substrate", AI Engineer conf 2026-07-22 — youtube VGN22pPpb-8 | Three pillars: business-facing ontology (concepts in human names, not `if_name`), technical ontology (where data/code lives + schemas), mapping between them; execution traces as the learning loop. Explicitly: markdown/skills are "part of the solution, but not the solution". | Two-layer shape (semantic + structural) and the mapping between them; validates that our markdown maps need a deterministic substrate under them |
| 3 | Gruber 1993, "A Translation-Based Approach to Portable Ontology Specifications" | Canonical definition: "an explicit specification of a shared conceptualization". Both talks cite it. | Naming/definition discipline for topic files |
| 4 | schema.org / FOAF / Dublin Core / DBpedia (per ref 1) | Reuse existing taxonomies; don't reinvent terms where a stable one exists. | Term selection: prefer established names for cross-cutting concepts (e.g. PROV roles) |
| 5 | W3C PROV-DM | Provenance vocabulary (entity/activity/agent, wasGeneratedBy…) — already in ke from the arc-webui survey. | Ready-made vocabulary for the meta-ontology's "who produces/consumes what" edges |
| 6 | Microsoft GraphRAG (microsoft.github.io/graphrag) | Auto-extract entities+relations from a corpus, cluster into communities, pre-generate community summaries; global queries answered from the summary layer. | OVERVIEW.md = community-summary layer: low-res index loaded once, topic files = zoom targets |
| 7 | Zep/Graphiti (help.getzep.com/graphiti) | Temporal knowledge graph: facts carry valid/invalid times; new evidence **invalidates** old edges instead of deleting them. | Staleness is a property of claims, not files → §5 layer 1 (evidence + surveyed date per claim); drift = invalidation, keep history in git |
| 8 | Aider repo map (aider.chat/docs/repomap.html) | Ranked tree-sitter symbol map as LLM context — cheap deterministic structural substrate under judgment. | Confirms the codemap interlock: deterministic structure below, semantic meaning above (§4.1) |
| 9 | C4 model (c4model.com) | Fixed resolutions: Context → Container → Component → Code; each level a separate diagram. | Topic files are C4-style zoom levels of one map, not freeform essays |
| 10 | DDD bounded contexts + ubiquitous language (Evans) | Each context has its own vocabulary; integration patterns relate contexts. CONTEXT.md is already this per repo. | Repo ontology = bounded context map; meta-ontology = integration layer (§4.5); CONTEXT.md stays the term authority |
| 11 | OpenTelemetry Semantic Conventions | A shared vocabulary standard with explicit versioning and stable/development status per attribute. | How the meta-ontology avoids drift: terms get status (stable/provisional) like OTel attributes |

## 3. Skill shape

`skills/map-ontology/SKILL.md` in arc-skills. Two scopes, one process.

### Scopes
- `map-ontology <repo>` — repo ontology → `<repo>/docs/ontology/` (OVERVIEW.md + topic files; layout per §5d B).
- `map-ontology --meta` — estate ontology → `~/vault/ontology/` (already exists; skill refreshes it).

Placement is the operator policy from the pilot, not a per-run choice.

### Process
1. **Survey** (read-only): repos, configs, crons, daemons, ledger shape, existing CONTEXT.md / ADRs / codemap/. For `--meta`: also read each repo's ontology OVERVIEW if present — meta composes from the parts.
2. **Draft**: `OVERVIEW.md` = low-res index (GraphRAG community-summary shape): one line per concept + link to its topic file, nothing restated in both places. Topic files = C4 zoom levels: components, contracts/edges, roles, data flows, scheduling — sized ~2–5KB each, split when a topic outgrows that.
3. **Term pass**: every term either exists in CONTEXT.md (repo scope) or gets added there with the grill-with-docs discipline; cross-cutting terms checked against ref 4/5 taxonomies first.
4. **Findings pass**: overlaps, conflicts, gaps, stale claims → ledger tickets via bookie (kind=task, class per severity), exactly like the pilot's findings.md. Findings file is written, then its tickets filed, then it links them.
5. **Register**: one-line reference from the scope's agents.md/AGENTS.md so sessions actually load it ("referenced from the global agents.md" was in the original request).

### Claim format (the staleness-enabling convention)
Every load-bearing claim carries evidence inline: path, crontab line, ADR number, or command. Topic file frontmatter:

```yaml
surveyed_at_sha: 3f9c2ab    # commit this file was last verified against (certification anchor, §5d A)
scope: [src/ledger/, bin/ledger.ts]   # paths/dirs this doc covers; missing = whole repo (fail-closed)
status: stable               # stable | provisional (OTel-style, ref 11)
```

Reader rule (written into the skill and agents.md): **an ontology is a hint to verify, never ground truth** — consistent with the zero-agent-trust house rule. `git diff --name-only <surveyed_at_sha>..HEAD -- <scope>` shows exactly what has moved since certification; non-empty = stale, and the diff targets the refresh at the sections that moved.

## 4. Interlocks (the core question)

### 4.1 codemap — interlock, do NOT supersede
Different axes: codemap is **structural** (modules, seams, dead/untested/redundant — deterministic, no LLM, git-tracked IR). map-ontology is **semantic** (concepts, roles, contracts, why-things-exist — judgment-based). This is exactly refs 2 and 8's two-layer shape: deterministic substrate below, meaning above.
Mechanics: codemap output is an *input* to the repo survey (module shapes ground the components topic file); the ontology names what codemap can't see (ownership, role, contract intent). Codemap's own SKILL.md already draws this line ("codemap = shape, improve-codebase-architecture = deepening") — map-ontology slots in as the semantic sibling. Neither regenerates the other; both git-track their artifacts so drift is diffable.

### 4.2 improve-codebase-architecture — consumer + updater
It reads CONTEXT.md vocabulary + ADRs and proposes deepening refactors. The repo ontology is its richer input: concept map + seams + contracts tell it *where* friction lives before the Explore subagent walks code.
Reverse edge: when a deepening refactor merges, the components/contracts topic files get updated in the same PR (same discipline as "regenerate codemap with the change"). The skill states both edges explicitly.

### 4.3 CONTEXT.md — stays the term authority, untouched
CONTEXT.md's discipline (definitions only, no implementation, no decisions) is exactly right and already load-bearing (interviewer intake, improve-codebase-architecture, grill-with-docs all read it). Merging it into an ontology file would couple a fast-changing glossary to a slower survey artifact.
Instead: the repo ontology *references* CONTEXT.md as its term source; the skill's term pass (§3.4) writes new terms back into CONTEXT.md. One definition per term, one home.

### 4.4 wayfinder — process vs artifact, delegate when foggy
wayfinder is a **process** (map of investigation tickets toward a destination, consumed until the way is clear). map-ontology is an **artifact** (persistent semantic map + drift regime). The pilot was effectively a one-shot wayfinder without the fog machinery.
Rule: if the survey scope is too big for one session (fog present), map-ontology delegates charting to wayfinder and resolves tickets until the map is drawable; small scopes go direct. Findings already land as ledger tickets, so no new tracker surface.

### 4.5 meta-ontology — bounded contexts + integration layer
Each repo ontology = a DDD bounded context (its own vocabulary, ref 10). `~/vault/ontology/` = the integration layer: how contexts relate (contracts, data flows, roles) using PROV-style edge vocabulary (ref 5). The meta survey composes from repo OVERVIEWs where they exist and marks composed-from claims with their source + that source's `surveyed:` date — so meta staleness is bounded by its inputs' staleness (source + that source's `surveyed_at_sha`).

## 5. Staleness regime (the dangerous part)

Recommendation: **hygiene sweep, not pre-commit** — three layers, cheapest first.

1. **Per-claim evidence + surveyed date** (§3 claim format). Makes staleness *measurable* instead of vibes; git history is the invalidation log (Graphiti's invalidate-don't-delete, ref 7).
2. **Deterministic drift check in the hygiene tick** — no LLM, cheap, daily: for each ontology file, verify its machine-checkable claims — referenced paths exist, crontab entries present, ledger aliases/roles match, AND `git diff --name-only <surveyed_at_sha>..HEAD -- <scope>` is empty (no scoped change since certification — staleness is change-based, not time-based; the 14d age cap is retired, §5d A). Output: drift report; >0 broken claims or non-empty scoped diff → one ledger ticket (skip-not-stack by stable title), oldest scope first. Same CAM shape as the worktree-hygiene driver already filed — it can be a second rule in the same collector, not a new daemon.
3. **Full re-survey on demand** — skill invocation after major change (migration merged, ADR landed) or when the drift ticket says >K claims broken in one file.

Why not pre-commit:
- Meta claims span crons, daemons, and other repos — a commit in one repo can't verify them; the check would pass while lying.
- Pre-commit couples "map is stale" to "commit blocked": either map updates ride into every PR (noise) or commits stall on judgment work (friction).
- Codemap already proved the better pattern for what *is* commit-verifiable: git-tracked artifact, regenerated with the change, diffed by git. The semantic layer can't regenerate cheaply at commit time — that's precisely why layers 2–3 replace it.

(If the captain wants a commit-time guard anyway: the only sane version is "referenced paths still exist" for repo-scoped files, as an opt-in CI check. Not recommended first.)

## 5a. POLICY ruling on lifecycle ordering (2026-08-25, herdr wF:p1)

Ruling: **Option 3 — periodic deterministic sync — is primary.** It alone carries the "the ontology is correct" guarantee, because under zero-agent-trust only a check of claims against machine-checkable reality (not any authoring ordering) can certify them.

1. Zero-agent-trust inverts Option 1: an intent-first ontology that code "conforms to" makes untrusted agent output the authority and flips the check direction to code→ontology instead of ontology→reality — the exact inversion the house rule forbids. Design-time intent maps stay drafts; they gain no authority until merged state is reflected back and the checker passes.
2. Option 2 can't catch the drift that makes a map dangerous: same-PR updates only touch what an author believes they changed; dead daemons, removed crons, ghost aliases, and cross-repo claims rot while the file looks maintained. That is precisely the failure class the pilot existed to find (11 real findings no PR would have updated) — Option 2 is a freshness courtesy, not a trust anchor.
3. Option 3 is the only ordering with a deterministic, LLM-free mechanism already designed (the worktree-hygiene drift rule). A no-LLM check is the substrate this house trusts (cf. codemap), so its guarantee doesn't depend on believing any agent output. Honest bound: it certifies the machine-checkable layer (paths/crons/aliases resolve) and age-flags the semantic layer for re-survey — not a blanket certification of meaning.

Operationalisation (SKILL.md must state): a claim is "correct" only while its inline evidence resolves against reality per the deterministic drift sweep; `surveyed:` recency means "verify before acting", never "trust"; design-time intent maps (Option 1) and same-PR updates (Option 2) are demoted to freshness conventions that reduce sweep load but never substitute for the check.

## 5b. POLICY ruling on retention / rebuild policy (2026-08-25, herdr wF:p1)

Operator question: rebuild from scratch vs verify existing? track commit version + delta changes? mirror Matt Pocock's discard-specs-on-completion practice — self-destruct ontologies on commit changes?

**Part 1 — rebuild vs verify: PARTIALLY DISAGREE with director. Mandate verify-first with targeted regenerate, not from-scratch rebuild.**
- A from-scratch rebuild discards the semantic judgments (roles, contract intent, why-things-exist) that are expensive to establish and not machine-recoverable; regenerating cold re-litigates them and drifts against the prior map. The existing ontology is the diff base: check each claim against reality, regenerate only the broken/stale subset, carry forward the rest.
- "Files disposable" is true of the structure, false of the semantic content — conflate them and every survey quietly re-decides role/ownership questions that CONTEXT.md already settled.
- SKILL.md: "On refresh, VERIFY existing claims against reality and regenerate only those that fail or are age-flagged; the prior ontology is the diff base, never a from-scratch starting point."

**Part 2 — commit-version / delta tracking: AGREE with the conclusion (no invalidation index), but correct the premise.**
- "Git already tracks file versions" is wrong at claim granularity: git tracks file version, and a file can be git-unchanged while a claim in it rots (daemon dies, ontology untouched). The thing doing claim-level delta detection is the deterministic sweep, not git — SKILL.md must not encode "git gives us claim invalidation" as a false premise.
- Graphiti-style per-edge temporal tracking is still over-engineered for a 35-repo estate; `surveyed:` + sweep is the right ceiling.
- SKILL.md: "Delta detection is the deterministic sweep re-checking each machine-verifiable claim against reality, independent of git diff; surveyed: bounds semantic claims. No per-claim invalidation index."

**Part 3 — Pocock mirror / self-destruct: AGREE with the split and with rejecting self-destruct-on-commit; sharpen one asymmetry.**
- Self-destruct-on-commit inverts the drift regime into churn (every commit invalidates → every session re-surveys → zero continuity, age-flag meaningless) — correctly rejected. Meta persists + swept: agree.
- Sharpening on "repo = optional cache-like": meta composes from repo OVERVIEWs (§4.5), so making the whole repo ontology disposable inverts the dependency (durable layer reads a disposable one). Fix by scope, not existence: topic files may be optional/absent, but if a repo has an ontology its OVERVIEW is the load-bearing composition input and must be swept-if-present; meta tags each composed-from claim with source + that source's `surveyed:`.
- SKILL.md: "Repo topic files are optional cache-like artifacts, swept only if present; a repo ontology's OVERVIEW, when present, is the meta composition input and must be swept. Meta never mandates repo ontologies exist — it composes from what does, with provenance + surveyed attribution."

## 5c. Read-side gate: pre-planning freshness check (operator decision, 2026-08-25)

The sweep certifies the ontology (write side), but nothing forced consumers to see the certificate before designing against it — a planning session could silently consume a stale map. Operator ruling: **blocking** — stale = no planning until refreshed. Not advisory/fail-open.

Mechanism (no hook machinery):
1. `ontology-check <scope>` — on-demand verb over the SAME claim classifier the drift sweep uses (one shared module, two entry points). Exit 0 fresh / 1 stale, per-claim report.
2. Intake line in every planning consumer — map-ontology refresh, wayfinder intake, improve-codebase-architecture step 0, director's plan step: "run `ontology-check` on your scope; stale → verify-first refresh per §5b before using any claim."

Blocking semantics:
- Stale verdict (claim check fails OR scoped diff since `surveyed_at_sha` non-empty) = **block**: the planning skill halts and runs a verify-first refresh; resumes only when the re-check passes. Refresh re-stamps `surveyed_at_sha: HEAD` after patching.
- Checker error (tooling failure, distinct from a stale verdict) = **fail-closed**, treated as stale. Survivable because the gate binds only ontology-consuming planning skills — a session repairing the checker itself never invokes planning intake, so a broken checker cannot deadlock its own repair.
- Scope = the artifact being planned: repo work checks `<repo>/ontology/` if present; cross-repo work additionally checks `~/vault/ontology/`.
- Blocking is survivable because §5b makes refresh cheap: patch the failed claims against reality, never cold-rebuild.

## 5d. Operator rulings — staleness anchor, layout, pilot (2026-08-27)

**A. Staleness oracle: certification SHA + scoped git diff.** Each ontology doc is stamped `surveyed_at_sha` — the commit it was verified against — so the reader can assert exactly what has changed since the map was written (`git diff <sha>..HEAD -- <scope>`). Non-empty scoped diff = stale, and the diff output targets the refresh at precisely the sections that moved. This **refines §5b Part 2 without contradicting it**: POLICY rejected a per-claim invalidation *index* and the premise that git auto-invalidates claims — both still hold. The stamp is one certification anchor per doc plus reader-facing change context, not an index; claim checks against live reality (dead daemons, missing crons) remain the sweep's job because runtime rot produces no commits. Staleness is now change-based, not time-based: a quiet repo stays fresh indefinitely; a hot repo gets small precise diffs.

**B. Canonical doc layout + inheritance (refined 2026-08-27 after captain's in-path-inheritance question).** Two artifact classes, one deterministic rule each:

1. **Context overlays** (AGENTS.md, CONTEXT.md): path-inherited — a file applies to its folder + subfolders; nearest wins on conflict; parent still applies as base. Free placement at any subtree root (src/, skills/vast-*/). AGENTS.md stays at repo root for harness auto-load.
2. **Identity registries** (root CHOICES.md, docs/adr/, docs/ontology/, docs/codemap/): exactly one per project, never nested — sub-scope granularity lives in metadata inside the artifact (ADR scope field, ontology doc `scope:` paths), not in path position. Rationale: nesting forks identity (duplicate ADR numbering, shadowed charters, non-deterministic sweep composition).

Canonical shape:
```
<repo>/AGENTS.md        # root; harness auto-load; carries a Map section pointing into docs/
<repo>/CHOICES.md       # root; project charter; tooling contract (apply-mission, estate-hygiene, director)
<repo>/CONTEXT.md       # root = repo-wide vocabulary; nestable in subtrees (nearest wins)
<repo>/docs/adr/        # flat, globally numbered per repo
<repo>/docs/ontology/   # OVERVIEW.md + topic files; per-doc scope: paths
<repo>/docs/codemap/    # generated whole-repo snapshot; filter by path, don't nest
```

Discoverability: root files are the index — every repo with docs/ content carries a Map section in its root AGENTS.md (one hop from what is always loaded). Moving registries into docs/ costs nothing on discovery because no harness auto-loads them anyway; skills read them by convention, and the convention is now single-valued. The earlier "CHOICES.md root-vs-docs" flag is resolved: root, per rule 2. Estate cutover ticketed separately (quality row, arc-skills).

**B-companion (doc hygiene, always-on):** a persistent .md file may only be created if the human explicitly requested it or a skill defines it as output; everything else goes to /tmp and is trashed when its referencing task completes. Recorded in AGENTS.md (always-on, all harnesses).

**C. Pilot.** arc-skills (operator override of the arc-agents default). Gate: full self-contained HTML rendering of the generated ontology shown to the operator **before merge** — work lands on a branch and merges only on explicit approval.

## 6. Open questions (one at a time in HITL)

1. ~~Staleness regime~~ — **resolved by POLICY ruling §5a**: sweep-only, Option 3 primary; no pre-commit path.
2. ~~Repo layout~~ — **resolved by operator ruling §5d B** (refined 2026-08-27): overlays nest by path; registries single-per-project under docs/; CHOICES.md at root. Estate cutover ticketed separately.
3. ~~Pilot target~~ — **resolved by operator ruling §5d C**: arc-skills, HTML render gate before merge.
4. ~~Pre-planning enforcement strength~~ — **resolved by operator decision 2026-08-25**: blocking (§5c).

## 7. Execution path (after approval)

- Ledger row 1 (mvp): skill + claim format (`surveyed_at_sha` anchor + scope, §5d A) + shared claim classifier (drift rule in hygiene collector AND `ontology-check <scope>` verb, TDD on the classifier) + blocking intake lines in planning skills (§5c); **pilot = arc-skills** per §5d C: survey → `docs/ontology/` + single self-contained `ontology.html` (inline CSS, no external assets) on a branch; show operator the full HTML rendering; merge only on explicit approval.
- Ledger row 2 (blocked on 1): `--meta` refresh of `~/vault/ontology/` composed from repo OVERVIEWs + agents.md registration sweep across repos.
