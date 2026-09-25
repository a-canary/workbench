# 02 — Models

What runs where. Watchlist SoT: `~/vault/api/models.json` (edit there, then `bun arc-skills/skills/api-providers/refresh.ts`).
Intel = curated score (Artificial Analysis index or internal ProgramBench) — filled by hand when measured, never guessed. ProgramBench (official arc gauge) is **MiniMax-only**.

## Local / self-hosted

| Model | Host | Served as | ctx | Notes |
|---|---|---|---|---|
| Bonsai-27B-Q1_0.gguf | 192.168.1.103:1234 (llama.cpp, 4060) | pi `llama-103`, arc-proxy endpoint `e103` | 131072 | The factory workhorse. 1-bit. Thinking model — reasoning eats `max_tokens` before content (~20 tokens ≈ empty content). |
| Bonsai-27B-Q1_0.gguf | 100.73.201.58:1234 (LM Studio) | pi `lm-studio` | 64000 | Local fallback copy |
| qwen3-4b-thinking-2507-distill-…-abliterated-i1 | 100.73.201.58:1234 | pi `lm-studio` | 32000 | small distill |
| qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2 | 100.73.201.58:1234 | pi `lm-studio` | 32000 | small distill |
| unsloth/Qwen3.8-27B-GGUF | Veles tunnel | pi `Veles` | 100000 / maxTok 65536 | `veles/qwen3.8-27b` — **last-resort fallback** (captain policy 2026-08-24) |
| unsloth/DeepSeek-V4-Flash-0731-GGUF | Veles tunnel | pi `Veles` | 100000 / maxTok 65536 | `ds v4 flash` |
| DavidAU/Qwen3.8-27B-Cold-Fusion-…-MTP-GGUF | Veles tunnel | pi `Veles` | 100000 / maxTok 65536 | experimental |

## Public

| Model | Provider | Notes |
|---|---|---|
| MiniMax-M2.7 | minimax | cli-proxy minimax default |
| MiniMax-M3 | minimax | pi alias `minimax-m3`; fast-pool head (no-think) |
| claude-fable-5 | anthropic | frontier tier; cli-proxy smart-pool head |
| claude-opus-4-8 | anthropic | smart-pool fallback |
| claude-sonnet-5 | anthropic | — |
| claude-haiku-4-5-20251001 | anthropic | cheap/fast tier; diagnostic subagent cheap-half |
| deepseek/deepseek-chat | openrouter | 163840 ctx |
| mistralai/mistral-small-3.2-24b-instruct | openrouter | 131072 ctx |
| gpt-oss-120b | cerebras | ~2200 tok/s smoke 2026-07-12; short-prompt tier only |
| zai-glm-4.7 / gemma-4-31b | cerebras | short-prompt tier only |
| zai-org/GLM-5-TEE | chutes | expert-horde judge default |
| zai-org/GLM-5.2-TEE | chutes | 1048576 ctx |
| deepseek-ai/DeepSeek-V3.2-TEE | chutes | 131072 ctx |
| moonshotai/Kimi-K2.6-TEE | chutes | 262144 ctx |
| MiniMaxAI/MiniMax-M2.5-TEE | chutes | MiniMax weights off-minimax-API; cheap bulk |

## Thinking-model budget rule

Local models (Bonsai, Qwen3.8, DeepSeek-V4-Flash) are thinking models: reasoning tokens consume `max_tokens` **before** content appears. Budget accordingly — a 512-token request can return empty content. Slow-lane callers set generous client timeouts (requests block in the queue until a slot frees).
