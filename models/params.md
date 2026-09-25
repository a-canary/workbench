# Model parameters

## Qwen3.8-27B (primary)
- Quant: Q6_K (quality/speed balance)
- Context: 131072 (fits on V100 with q8_0 KV)
- KV quant: q8_0 (saves ~4GB vs f16 at 131k)
- Temperature: 0.7 (creative) / 0.2 (deterministic tasks)
- Max tokens: 8192 (default)
- MTP: draft-mtp enabled (speculative decoding)

## Bonsai-27B
- Quant: Q1_0 (1-bit, experimental)
- Context: 64000-131072
- Use case: fast iteration, not production

## DeepSeek-V4-Flash
- Slow lane only (long-running batch tasks)
- Use `--slow-lane` flag with harness-bench
