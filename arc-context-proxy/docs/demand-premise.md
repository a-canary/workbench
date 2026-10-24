# Demand premise: do small local models degrade below their advertised context?

Resolves the ticket *Verify the demand premise: do small local models degrade below their advertised context?*

**Verdict: the premise HOLDS, but the load-bearing failure is quality, not memory.**
I entered this expecting memory infeasibility to be the stronger justification. The measurements say the opposite. That reverses the note I attached to the ticket earlier.

---

## 1. Quality degradation — CONFIRMED, and worse than the folklore

The single unverified source in the prior-art survey claimed reliable context for 7B–8B models tops out near 16K–32K despite advertised 128K. Independent measured data supports it.

RULER (arXiv 2404.06654, NVIDIA), effective length = longest length still beating Llama2-7B-at-4K (85.6%):

| Model | Advertised | RULER effective | Ratio |
|---|---|---|---|
| Llama 3.1 8B | 128K | 32K | 0.25 |
| Mistral Nemo 12B | 128K | 16K | 0.125 |
| Phi-3-mini 3.8B | 128K | 32K | 0.25 |
| Phi-3-medium 14B | 128K | 32K | 0.25 |
| GLM4 9B | 1M | 64K | 0.06 |
| Llama 3.1 70B | 128K | 64K | 0.50 |
| GPT-4-1106 | 128K | 64K | 0.50 |

Not a small-model-only defect — frontier models also land at 0.50 — but small models are worse, and the absolute number is what matters to a self-hoster.

NoLiMa (arXiv 2502.05167) removes lexical shortcuts and is brutal: Llama 3.1 8B effective **1K**, scoring 76.7 at base → **14.2 at 32K**. Gemma 3 12B: 87.4 → **7.3**. Even GPT-4o only reaches 8K effective. The gap between RULER's 32K and NoLiMa's 1K for the same model is itself the finding — measured effective context depends heavily on whether the benchmark can be gamed by surface lexical matching.

UNVERIFIED: Qwen3 8B (64K) and Qwen2.5-7B-1M (>128K) rows are vendor-reported, not NVIDIA-run. Qwen is the only family claiming a favourable ratio, and it is the only one grading its own homework. No published RULER data found for Gemma 2/3, Llama 3.2/3.3 8B, Mistral Small, or Phi-4.

## 2. Task-class dependence — CONFIRMED, and this is the project's best evidence

Aggregation collapses far earlier than retrieval, on the same model at the same length.

Llama 3.1 8B, per-task RULER:

| Length | NIAH (retrieval) | VT | CWE | FWE (aggregation) |
|---|---|---|---|---|
| 16K | 96.5–100 | 99.6 | 98.0 | 89.6 |
| 32K | 97.4–100 | 99.8 | 95.2 | **50.4** |

FWE loses 39 points between 16K and 32K while retrieval is untouched. Granite-3.1-8B repeats the pattern: past 32K, CWE falls to **0.8** while NIAH holds at 96.6. RULER's own paper notes that at 128K, >80% of Yi-34B's CWE output is a copied one-shot example — the model stops aggregating and starts parroting.

**VT is the exception**: variable tracking stays ~99.6–99.8 at 32K and patterns with retrieval, not aggregation. Do not treat VT as an aggregation task when designing the eval.

This is the strongest single result for the project. It means the addressable failure arrives *sooner* than the headline effective-context number suggests, on precisely the workload class this design targets — and it is the class RAG serves worst (consistent with the GlobalQA 1.51 vs 6.63 F1 result in prior-art.md).

UNVERIFIED: NVIDIA's leaderboard publishes per-length averages only. The per-category breakdown comes from two third-party runs, not the official leaderboard.

## 3. Memory infeasibility — MUCH WEAKER than I claimed

KV cache = `2 × layers × kv_heads × head_dim × bytes × tokens`. Computed from published `config.json` values, cross-checked against an independent survey. No vendor publishes KV-GB-at-128K figures, so this is architecture-derived only.

| Model | Layers | KV heads | head_dim | Bytes/token (fp16) |
|---|---|---|---|---|
| Llama 3.1 8B | 32 | 8 | 128 | 131,072 |
| Qwen3 8B | 36 | 8 | 128 | 147,456 |
| Mistral Small 24B | 40 | 8 | 128 | 163,840 |
| Gemma 3 12B | 8 global + 40 local(1024) | 8 | 256 | ~65,536 global-only |

Max context that fits (q4_K_M weights, ~8% runtime overhead):

| Model | KV | 8GB | 12GB | 16GB | 24GB |
|---|---|---|---|---|---|
| Llama 3.1 8B | fp16 | 21k | 50k | 80k | 139k |
| Llama 3.1 8B | q8 | 42k | 101k | 160k | 278k |
| Qwen3 8B | fp16 | 16k | 42k | 69k | 121k |
| Mistral Small 24B | fp16 | OOM | OOM | 7k | 54k |
| Mistral Small 24B | q8 | OOM | OOM | 15k | 109k |
| Gemma 3 12B (SWA) | fp16 | 0k | 54k | 113k | 231k |
| Gemma 3 12B (SWA) | q8 | 0k | 114k | 232k | 467k |

**Correction to my own first pass**: I initially computed Gemma 3 12B at 48 GB for 128K by treating all 48 layers as global. Gemma 3 uses `sliding_window: 1024` with `sliding_window_pattern: 6` — only 8 of 48 layers are global, so the real figure is ~8.3 GB. Gemma goes from worst to best in the table.

Two consequences, both bad for a memory-based pitch:

- **Architecture beats compression.** Sliding-window attention buys Gemma ~6×. q8 quantisation buys 2×. Model architects are dismantling the memory wall faster than a proxy could, and shipping it in the model.
- **q8 KV cache is nearly free**: ~0.004 perplexity cost for a 50% cut. On 12GB that puts Llama 3.1 8B at ~101k — most of the advertised window, via one flag. q4 costs ~0.21 ppl (~50× worse) and saves only ~66% rather than 75%, due to per-block scale overhead. K quantises well, V does not — confirmed independently by llama.cpp measurement and by KIVI (arXiv 2402.02750) finding K needs per-channel and V per-token treatment. Sensible fallback is `-ctk q4_0 -ctv q8_0`.

Memory infeasibility survives only for **Mistral Small 24B** — dense GQA, heavy weights, still short of 128K at q8 on 24GB. One model is not a market.

## 4. What engines actually do when it does not fit

Three materially different behaviours:

| Engine | Behaviour |
|---|---|
| vLLM | Refuses to start. Hard `ValueError` at init; auto-shrink is an open feature request, not current behaviour |
| llama.cpp | Hard OOM at load (`cudaMalloc failed`). No graceful degradation |
| Ollama | Silently offloads to system RAM (order-of-magnitude slowdown) **and** silently drops oldest tokens on overflow |

Ollama is the one that matters. Default `num_ctx` is 2048, and via the OpenAI-compatible API a user can send 100K tokens and have the model see 2K, with no error raised. "Loud refusal" is a solved problem for the user; "silent truncation" is not.

UNVERIFIED: Ollama truncation/offload behaviour comes from a downstream issue and secondary reports. No official Ollama doc states the truncation policy. Worth reproducing directly before it is load-bearing.

## Which way this points on the gate

**Do not close the gate.** The premise stands, restated:

> Not "your model cannot fit this" but "your model silently lies about what it retained — and it starts lying soonest on exactly the aggregation work you care about."

The pitch that dies is the memory pitch. q8 KV cache and sliding-window attention between them dissolve most of the VRAM wall for the 8B class, and both are free, shipped, and require no proxy. Any argument resting on "128K does not fit in consumer VRAM" should be dropped.

The pitch that strengthens is aggregation quality. FWE at 50.4 at 32K on a model RULER rates as *effective* at 32K is the sharpest number found: the model is rated competent at exactly the length where the target workload is already half-broken.

### Consequences for other tickets

- ***What is the achievable quality per unit of VRAM and wall-clock?*** — the incumbent baseline is now specifically **q8 KV cache** (~0.004 ppl for 2×), not quantised-KV generally. Beating q4 is not sufficient; nobody serious runs q4 KV given the ~50× quality cost. One opening: quantisation's throughput penalty *grows* with context (reported ~−11% at 24K vs ~−37% at 110K), so it degrades precisely in the regime this design targets. UNVERIFIED, from a secondary summary — worth confirming, since a wall-clock-denominated design gains from an incumbent that is slowest where it is needed most.
- ***Define the eval*** — gate on aggregation (RULER CWE/FWE), never on NIAH; the measurements show retrieval stays near-perfect while aggregation collapses, so any NIAH-based result would be uninformative. **Exclude VT from the aggregation set** — it patterns with retrieval. Confirms the existing choice of RULER FWE @128K as hillclimb instrument, and adds a reason: FWE is already half-broken at 32K, so there is headroom to measure at every length.
- ***Verify the demand premise*** (this ticket) — resolved.

## Sources

RULER: arXiv 2404.06654, github.com/NVIDIA/RULER · NoLiMa: arXiv 2502.05167 · KIVI: arXiv 2402.02750 · KVQuant: arXiv 2401.18079 · Red Hat Granite 3.1 benchmark (per-category RULER) · model `config.json` on HuggingFace for architecture parameters · vllm#2418, vllm#5976, vllm#7195; llama.cpp#16725, #15538 for OOM behaviour
