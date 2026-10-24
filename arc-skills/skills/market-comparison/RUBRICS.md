# Rubric Construction

Rubric is **informed by neighbors**, not designed in a vacuum. Find 8 neighbors first, observe what they cover, then design axes that capture industry expectations + differentiation opportunities.

Axis selection thresholds live in [SKILL.md](SKILL.md) (rubric construction). This file holds the axis vocabulary and worked examples.

## Rubric row format

Each axis row carries five values:

| Column | Source |
|--------|--------|
| Industry bar (best) | Top neighbor's score on this axis |
| Industry bar (avg) | Mean across all 8 neighbors |
| Our bar | What we'll deliver (must beat best for DIFFERENTIATE) |
| CLONE/DIFF | Match industry vs beat best |
| Evidence | Source (neighbor name, benchmark, repo path) |

## Universal axes (consider for all domains)

| Axis | What it measures |
|------|------------------|
| **Accessibility** | Can a newcomer get value in <5 min without docs? |
| **Completeness** | Does it solve the full problem or leave gaps requiring workarounds? |
| **Cost** | Money + time + cognitive load to adopt and maintain |
| **Durability** | Will it still work in 2 years? (maintained, not abandoned, not single-vendor dependent) |
| **Signal-to-noise** | Does the user get value without wading through fluff? |

## Domain-specific axes

### Open-source repo

| Axis | Scoring guide |
|------|--------------|
| **README clarity** | Understand what + install in <2 min from README alone? |
| **Test coverage** | Real tests covering documented API, not just smoke? |
| **API surface** | Minimal and composable, or grab-bag? |
| **Maintenance signal** | Recent commits? Issues addressed? Or 200 open PRs abandoned? |
| **Dependency weight** | Heavy/proprietary transitive deps? |

### Blog post / article

| Axis | Scoring guide |
|------|--------------|
| **Originality** | New take or 50th rephrasing of same idea? |
| **Depth** | Past surface into mechanism/tradeoff/proof? |
| **Scannability** | Key points from headings + bold + code alone? |
| **Accuracy** | Claims backed by evidence (benchmarks, citations, examples)? |
| **Actionability** | Reader can do something concrete after? |

### YouTube / video

| Axis | Scoring guide |
|------|--------------|
| **Hook** | First 15s earn next 10 min? |
| **Pacing** | Dead air or every second earning its place? |
| **Production** | Clear audio, visuals support point? |
| **Teaching clarity** | Beginner can follow without rewinding? |
| **Payoff** | Ending delivers on title's promise? |

### Product / feature launch

| Axis | Scoring guide |
|------|--------------|
| **Time-to-value** | Signup to first output — minutes or days? |
| **Onboarding** | Guided or blank screen? |
| **Pricing clarity** | Cost in 30s or "contact sales"? |
| **Integration** | Works with what I have, or parallel workflow? |
| **Support signal** | Docs, community, response time? |

### Social post

| Axis | Scoring guide |
|------|--------------|
| **Scroll-stop** | Stop scrolling or blend in? |
| **Value density** | Insight per word — high or padded? |
| **Authenticity** | Person or press release? |
| **Engagement hook** | Reason to reply/share or just broadcast? |
| **Audience fit** | Right depth for platform? |

## Example: rubric for a CLI compaction tool (pi-vcc-style)

After reading 8 neighbors (other compaction/compaction tools), the rubric might look like:

| Axis | Best | Avg | Our bar | CLONE/DIFF | Evidence |
|------|------|-----|---------|------------|----------|
| Token reduction | 60% | 35% | 70% | DIFF | Algorithm: extract-only, no LLM |
| Latency | 500ms | 2000ms | 100ms | DIFF | Bench: pure extraction, no API |
| Zero external deps | No | No | Yes | DIFF | Deterministic, no LLM calls |
| Semantic sections | 2 | 3 | 4 | DIFF | Goal/Context/Refs/Signals |
| Configurability | High | Med | Med | CLONE | Match neighbor X |
| Install footprint | 50MB | 20MB | 5MB | DIFF | Single binary, no native deps |

DIFFERENTIATE axes (5) all have mechanisms. CLONE axis (1) references a specific neighbor's approach.
