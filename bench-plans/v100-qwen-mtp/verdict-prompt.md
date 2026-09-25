You are writing the verdict for a GPU inference benchmark. Attached: results.json (one row per llama-server config, greedy decode, same prompt) and mechanical.json (computed numbers and the decision; it is authoritative).
Write at most 15 lines of Markdown:
1. First line exactly: `DECISION: <decision from mechanical.json>`
2. A 4-column table: config, decode tok/s, delta vs baseline %, same text as baseline.
3. Two sentences on what the delta means for a daily batch of ~20 requests of ~1500 output tokens each.
4. One sentence on quality: speculative decoding is exact, so any `false` in same_text_as_baseline is a bug to report, not a tuning result.
Do not invent numbers; use only values present in the attachments.
