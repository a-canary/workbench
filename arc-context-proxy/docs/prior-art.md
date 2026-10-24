# Prior art: what already solves 1M-context-through-small-context?

Research resolving ticket `prior-art-what-already-solves-1m-context`. Dated 2026-08-02.
Five parallel surveys: compression, existing shims, commodity RAG, agentic code search, long-context benchmarks.

**Trust note.** Subagent output, verified only where cited. Numbers below carry their sources; claims flagged UNVERIFIED were not confirmed against a primary benchmark. Do not treat this as measured evidence for the gate — it is a map of what others have measured.

## Headline

The niche is unoccupied but the premise is damaged. Nothing ships a 1M-token prompt over the OpenAI wire protocol decomposed into small-context calls. But the design as originally framed — programmatic AST parsing plus many 32k calls to compress a payload — is contradicted by three independent literatures. One narrow territory survives, and it is not the one the idea started in.

## 1. Compression: half the field is unusable, the rest is a 2-6x squeeze

Every high-ratio method needs model weights or KV access: Gist tokens (26x), AutoCompressor (30:1), ICAE (15x), xRAG (178x), PISCO. Against a black-box featherless endpoint these are off the table.

Usable methods are text-to-text only — LLMLingua family (needs a *local helper* model's logits, not the target's) and hierarchical merging. Validated at **2-6x on <=32k inputs**, not 30x on 1M.

Two findings that constrain the design:

- [Characterizing Prompt Compression](https://arxiv.org/pdf/2407.08892): **plain truncation and retrieval-based chunk selection frequently match or beat LLMLingua/LLMLingua-2.** No universal winner. Complex token pruning often fails to earn its overhead.
- [Rate-distortion limits](https://ar5iv.labs.arxiv.org/html/2407.15504): all black-box methods sit far below the optimal curve, and **query-agnostic compression is theoretically capped** — headroom is in query-aware compression.

Multi-hop retrieval degrades worst (54% relative drop, HotpotQA). Hierarchical merging is the only method proven at 1M scale, with known hallucination amplification across merge levels, partly mitigated by re-injecting source spans ([2502.00977](https://arxiv.org/abs/2502.00977)).

**Consequence:** the eval MUST include a naive-truncation baseline. If the pipeline cannot beat truncation, it has no reason to exist. Query-aware compression is where headroom lives, but it kills offline caching of compressed artifacts — direct tension with the caching in the original idea.

## 2. Existing shims: niche unoccupied, moat thin

| Project | Shape | Why it does not subsume |
|---|---|---|
| [Supermemory Infinite Chat](https://supermemory.ai/blog/extending-context-windows-in-llms) | Drop-in OpenAI-compatible proxy, chunk+embed+rerank | Targets growing *transcripts*, not one huge prompt. **Closest thing that exists.** |
| [Letta / MemGPT](https://aiwiki.ai/wiki/letta) | OS-style memory paging | Agent framework, not a passthrough proxy |
| llama.cpp / Ollama / LM Studio | `--context-shift` eviction | Silently drops information. This is the problem, not a solution |
| LangChain map_reduce / refine | Chunk-summarize-merge chains | Library, app rewrite. Culturally retired — long-context models killed the use case |
| Claude Code / Aider / Cline | Agentic search | They *are* the app; cannot serve someone else's `/v1/chat/completions` |

Nothing combines: single ~1M-token request over the OpenAI wire, decomposed internally, returned as an ordinary completion.

**But:** Supermemory's retrieval machinery is already proxy-shaped — extending it from transcript-chunking to single-prompt-chunking is modest work. The moat is thin.

**Demand-side risk.** Local models now commonly ship 128K native context, shrinking the "capped at 32k" population. The counter-claim — that *reliable* context for 7B-8B models tops out near 16K-32K regardless of advertised window ([promptquorum](https://www.promptquorum.com/local-llms/long-context-local-llms)) — is UNVERIFIED single-source but load-bearing. If true, the pitch is not "your model can't fit 1M tokens" but "your model's advertised window lies." **Verify before the gate.**

## 3. Code path: already built, and the industry moved past it

**Aider's repo-map IS this project's code front-end**: tree-sitter extracts defs/refs, files are graph nodes, symbol references are edges, PageRank ranks identifiers, binary search packs into a token budget. Shipped 2023, MIT-licensed ([aider.chat](https://aider.chat/2023/10/22/repomap.html)). The AST front-end is not novel.

The structural argument is worse than the duplication. [SWE-Explore](https://arxiv.org/html/2606.07297v1): sparse retrievers and lightweight dense retrievers score **near Random** on repository exploration; every agentic explorer scores substantially higher. **Compressing 1M tokens into a payload is one-shot retrieval by construction** — you commit to a relevance judgment before the model knows what it needs. This is the same flaw the rate-distortion analysis names from the compression side. Two independent literatures, one conclusion.

Costly signals: [Cline publicly refuses to index](https://cline.bot/blog/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing) (staleness, security, lexical-similarity-is-not-causal-relevance). Sourcegraph shipped Cody embeddings then **deprecated them** for keyword/structural search — from the vendor with the most code-search infrastructure.

Counter-evidence, first-party and vendor-favorable: [Cursor semantic search](https://cursor.com/blog/semsearch) reports **+12.5% mean accuracy over grep-only** on their Context Bench, but production deltas are small — +0.3% code retention overall, +2.6% on codebases >=1000 files. So retrieval survives as a *tool inside the agentic loop*, not as a payload compressor.

SWE-bench: BM25 @13k gives Claude 2 a 1.96% resolve rate; oracle retrieval of gold-patched files gives 4.8%. Context selection genuinely matters — roughly 2.4x. It is the *one-shot* framing that fails, not the idea that context selection is valuable.

UNVERIFIED: Aider's "significantly higher edit accuracy" appears only in secondary summaries; no primary benchmark found. Third-party wasted-read figures (1-in-3 baseline to 1-in-8 grep+semantic) are notes on a talk, not a published eval.

## 4. Prose path: local lookup is closed, global aggregation is wide open

**Do not build for local lookup.** [Anthropic contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval): top-20 failure 5.7% -> 3.7% with contextual embeddings -> 2.9% adding contextual BM25, -67% total with a reranker. ~2% miss rate from an off-the-shelf recipe at roughly 1/1000th the cost of stuffing 1M tokens.

**Global comprehension is genuinely unsolved.** [GlobalQA](https://arxiv.org/abs/2510.26205) — count, extremum, sort, top-k across a corpus — best RAG baseline **1.51 F1**; purpose-built GlobalRAG **6.63 F1**. Both near-zero. Top-k cannot answer a question whose answer is a function of the whole set, because top-k is a sample by construction. Structural failure, not a tuning gap.

**But the proposed shape loses here too.** Map-reduce over fixed windows is the known-weak baseline [GraphRAG](https://arxiv.org/pdf/2404.16130) was measured against and beat. The winners in this territory are hierarchical index + symbolic aggregation. The pipeline must beat GraphRAG/LazyGraphRAG, not naive RAG.

UNVERIFIED: GraphRAG's comprehensiveness wins are LLM-as-judge on comprehensiveness/diversity, not verified factual accuracy. Do not gate on those numbers.

## 5. Benchmarks: a gate that retrieval cannot fake exists

Three tiers by what a retrieval pipeline can fake:

1. **Retrieval-only, gameable**: NIAH, LOFT, most of LongBench, MRCR.
2. **Latent/non-lexical, harder**: NoLiMa, RULER-VT, BABILong.
3. **Aggregation over the whole context, NOT gameable**: **Oolong**, **RULER CWE/FWE**, Michelangelo Latent List.

Tier 3 is the only honest gate — tiers 1 and 2 both permit discarding >99% of tokens as noise.

- **[Oolong](https://arxiv.org/abs/2511.02817)** (Nov 2025): atomic per-chunk analysis then distributional questions. Explicitly built so nearly all context tokens cannot be discarded. GPT-5, Sonnet-4, Gemini-2.5-Pro all **<50%** at 128K. Published frontier ceiling means you cannot fool yourself with a "good" score.
- **[RULER](https://arxiv.org/abs/2404.06654) CWE/FWE + VT**: synthetic, self-generating at any length, extends to 1M for free. Report "effective context length."

**Cheap iteration proxy: RULER FWE at fixed 128K.** Synthetic, zero labeling cost, no API judge, runs in minutes for pennies. Requires reading every token — you cannot count frequencies from top-k. Continuous score that moves smoothly under hillclimbing. Keep Oolong-**real** as a held-out set, never tuned against.

**Do NOT gate on** LOFT (it is the RAG control arm), HELMET (contains RAG tasks), LongBench v2, or plain MRCR.

**Terminal-Bench 2** ([arXiv 2601.11868](https://arxiv.org/html/2601.11868v1)): 89 tasks, containerized terminal, pass/fail resolution rate, **$1-$100/run** (one documented 89-task run ~$55). Measures agentic task completion, not context retention — most tasks fit in 32k anyway. Good *end* metric, bad *gate* for this claim. Confirms the concern already on the map.

Calibration: even native 1M models are far from solved. MRCR v2 8-needle @1M — Claude Opus 4.6 76%, Gemini 3.1 Pro 26.3%, Sonnet 4.5 18.5%. NoLiMa: GPT-4o 99.3% -> 69.7% at 32K. **The bar is "match the native model," not "score high."**

## What is NOT solved — the gap that would justify building

1. **Corpus-level aggregation.** 1.51-6.63 F1 is the state of the art. Retrieval fails structurally, not incidentally.
2. **A transparent proxy delivering it.** Everything that does multi-call reasoning requires app restructuring; everything drop-in only evicts or retrieves over chat history.
3. **Serving it to small-context models.** All aggregation work above assumes a large-context frontier model.

The honest framing is no longer "AST compression makes a 32k model act like a 1M model." It is: **can a transparent OpenAI-compatible proxy make a small-context model competitive at whole-corpus aggregation — the one task where retrieval provably fails — and beat truncation, Aider's repo-map, and GraphRAG while doing it?**

## Consequences for the map

- **"AST compression" is the wrong center.** The code front-end duplicates Aider; the prose front-end loses to commodity RAG on lookup. The defensible territory is aggregation, which needs hierarchical index + symbolic aggregation, not AST parsing.
- **One-shot payload compression is contradicted from two directions** (SWE-Explore; rate-distortion). Any surviving design must be iterative/query-aware — which conflicts with caching compressed artifacts.
- **The eval needs three baselines, not one**: naive truncation, commodity RAG (contextual retrieval + rerank), and the native large-context model as the ceiling.
- **Gate metric settled enough to specify**: Oolong + RULER CWE/FWE, with RULER FWE as the hillclimb proxy. TB2 demoted to end metric.
- **Verify the demand premise** (advertised vs reliable context on small local models) before the gate. It is the load-bearing justification and rests on one source.

---

# CORRECTION (2026-08-02, same day): the surveyed design was not the proposed design

The analysis above evaluated **1M -> 1x32k**: rank, compress, discard, make one call. The operator clarified the actual design is **1M -> Nx32k**: segment the context into semantic units, dispatch many calls that each read a *different* unit, and assemble a response from their structured outputs. Nothing is discarded at segmentation time.

That is a different system, and it survives objections the compressed-payload design does not. What follows supersedes the "Consequences for the map" section above where they conflict.

## What the correction invalidates

**The SWE-Explore objection largely does not apply.** Its finding is that one-shot retrievers score near Random because they commit to a relevance judgment before the model knows what it needs. An Nx32k sweep that reads every unit makes no such commitment — there is no relevance bet at segmentation. Retrieval-scores-near-Random is a result about *sampling*; this is a *census*.

**The aggregation objection is answered in principle.** GlobalQA's 1.51 F1 for RAG is caused by top-k being a sample by construction, so a whole-set question is unanswerable from it. A map over all N units is not a sample. Count, extremum, sort, and top-k become structurally reachable. This is the single most important consequence: the one territory prior art identified as genuinely open is *exactly* the territory the Nx32k shape is built for.

**The truncation baseline is demoted but retained.** Truncation cannot perform a census, so it is no longer a serious competitor — it is a sanity floor. Keep it in the eval to catch degenerate implementations; stop treating it as the bar to clear.

**"AST compression" was always the wrong name** and the correction makes that sharper. Nothing is being compressed. The pipeline decomposes, labels, extracts, and reassembles.

## What survives, and why it is now the load-bearing risk

**Map-reduce over fixed windows is still the baseline GraphRAG beat.** This finding was measured against approximately the proposed shape, so it does not dissolve. But the *reason* it lost is specific and addressable: the failure is in the reduce step, not the map step. Forty chunks each reporting "roughly a dozen billing complaints" produce a total with error compounding at every merge level — the documented hallucination-amplification effect.

The fix is already in the operator's stage list but was not flagged as critical: **extract to structured output, then aggregate symbolically in code.** Each call emits `{unit_id, has_billing_bug: bool}`; the count is a SQL query, not an LLM estimate. Each call emits its local max; code takes the max of maxes. The LLM must never estimate a total. This is the difference between GraphRAG and the map-reduce it beat, and it is a materially stronger position than the one assessed above.

**Consequence for the eval:** the gate is not "beat naive RAG." It is "match or beat GraphRAG/LazyGraphRAG on aggregation, at small-context." That bar is higher than the original analysis implied and remains the honest test.

## The thesis is structure recovery, not chunking

Operator reinforcement: slicing by token offset is the *degenerate fallback*, not the mechanism. The context in the motivating example — assigned ticket, retrieved comments, changelog search hits — arrives with real structure. A byte-offset chunker destroys precisely the information that makes the problem tractable: it splits comment threads mid-argument and packs unrelated changelog entries into one window. The structure was given; slicing discards it.

The elegant form: parse the context into typed units with relationships (task specification / accumulated constraint / evidence / superseded decision), and dispatch *semantic* units to the 32k calls. A comment thread goes as a thread. A function goes with its callers. Chunk only what could not be parsed.

This reframes the extract stage output. Not "a summary of chunk 7" but **claims with provenance**: *constraint C originated in comment 14, superseded by comment 31*. Claims compose across calls losslessly because they are atomic and carry their source. Summaries do not compose — merging two summaries loses which was authoritative. This directly addresses the hierarchical-merging hallucination problem from the compression survey, which is a merge-of-summaries failure.

## The strongest unexamined idea: the coverage ledger

The operator's stage list includes extract-all-questions -> extract-answer-per-question -> **extract unanswered questions** (equivalently task -> validation -> unvalidated).

Nothing in any of the five surveys has this. It is not a compression technique; it is a **runtime sufficiency signal** — evidence, computed with no ground truth available, that the sweep did or did not cover the request. Every system surveyed answers with uniform confidence whether or not it actually found what it needed. Silent failure is the characteristic failure mode of the entire field: the compressed-payload design's worst property is that it answers confidently from a payload missing the critical file.

A residue of unanswered questions gives the proxy a principled basis to sweep again, escalate, or state reduced confidence. It also supplies a natural termination condition for iteration and a plausible answer to the open fog item "failure mode when no compression suffices."

Treat this as a first-class component of the design, not an incidental stage.

## Revised open risks

1. **Structure recovery is the hard part, and "logically segment" hides it.** AST gives genuine structure for code. For a comment thread, structure exists but recovering it is an inference problem, not a parse. Where parsing ends and LLM-driven structure recovery begins — and whether the latter is cheap enough to run over 1M tokens — is the sharpest unresolved design question. The elegant version depends on it being solvable cheaply.
2. **Cost.** N calls over 1M tokens at ~32k each is a floor of ~30+ calls before any iteration, hierarchy, or re-sweep. The economic comparison is against renting a large-context model, not against doing nothing. This may be the binding constraint rather than any quality question.
3. **Aggregation correctness depends entirely on symbolic reduce.** If any total is produced by an LLM summing summaries, the design collapses into the baseline GraphRAG already beat.
4. **The demand premise is unchanged and still load-bearing.** See the separate ticket.

## What the correction does NOT change

- Local lookup remains closed by commodity RAG at ~1/1000th the cost. Do not target it. An Nx32k census is dramatically more expensive than a retrieval call that already works.
- Aider's repo-map remains the incumbent for code payloads.
- Weights/KV-access compression methods remain unusable against a black-box endpoint.
- Gate on aggregation-class benchmarks (Oolong, RULER CWE/FWE). This is reinforced, not weakened: those benchmarks require reading every token, which is exactly what the Nx32k shape does and what retrieval cannot.

---

# OBJECTIVE CORRECTION (2026-08-02): the currency is not money

Repo renamed `arc-ast-compression` -> **`arc-context-proxy`**. Nothing is compressed; AST is one parser in one tier of one stage. The name now says what the thing is.

More importantly, the operator restated the objective, and it invalidates the framing of the cost analysis above.

## The actual objective

> Hillclimb the logic to push **agenticCapability / totalCost**, making local LLMs effectively run with much larger context **at the cost of some speed — not at the cost of memory**.

Three consequences, each of which changes a conclusion drawn earlier in this document.

### 1. Wall-clock is the intended currency, not a concession

The cost analysis above treats N>=30 serial calls as a possible gate-closing liability. That is wrong for the target user. A self-hoster has already bought the GPU; marginal cost per call is electricity. Their binding constraint is **VRAM**, and VRAM is what a large KV cache consumes.

So the trade is deliberate: spend time, which the self-hoster has in abundance, to buy effective context, which they cannot buy any other way short of new hardware. "Slow but it fits" beats "fast but OOM" — and beats "fast but silently degraded," which is what a 128K-advertised model on a small VRAM budget actually delivers.

**This inverts the comparison.** Against an API-rate large-context model the pipeline looks expensive. Against the self-hoster's real alternative — a model that OOMs, or evicts, or quietly loses the middle — it is competitive at a cost they are already paying.

### 2. Peak memory is a hard constraint, and it is a design constraint

The N calls must be **sequential-capable at bounded VRAM**. A design that needs all N units resident, or that fans out to N concurrent model instances, defeats the entire purpose. The unit graph and accumulated claims live on disk or in host RAM; only one 32k window is ever in VRAM.

This is a first-class requirement, not an implementation detail, and it is not satisfied by default: hierarchical merge strategies that hold many summaries in flight, or that require a second model resident for scoring, violate it.

**Peak VRAM is therefore a headline metric alongside quality.** An honest report is a triple: `(quality, wall-clock, peak VRAM)`. Two systems with equal quality are not equivalent if one needs 24GB and the other 8GB.

### 3. The gate is a ratio, and it is hillclimbable

`agenticCapability / totalCost` is not a pass/fail threshold — it is a quantity to improve. That reframes the destination: the gate asks whether the ratio *moves under iteration*, not whether v1 clears some bar.

This makes the cheap-proxy metric more important than previously argued, because hillclimbing needs a signal that responds to small changes. RULER FWE at fixed 128K remains the right instrument: continuous, synthetic, pennies, and unanswerable from top-k.

It also means a v1 that merely *matches* a large-context model on quality while using a fraction of the VRAM is a **win**, not a null result. Equal capability at lower cost raises the ratio.

## What this changes on the map

- The economics ticket is rewritten. The question is not "does renting a large-context model win on price" but "what is the achievable quality per unit of VRAM and wall-clock, and does it improve under iteration."
- Peak VRAM joins the eval as a reported metric.
- Bounded-VRAM sequential execution becomes a design constraint on segmentation, extraction, and reduce.
- The demand-premise ticket gains a sharper form: the interesting failure is not "the model refuses 128K" but "the model accepts 128K and silently degrades, or the KV cache does not fit in consumer VRAM at all." Both are addressed by this design; the second is addressed by nothing else short of buying hardware.
