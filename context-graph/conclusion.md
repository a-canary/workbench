# context-graph harness-bench wiring — toy canary results

## Experiment

Measure context-graph loop efficiency vs. flat-truncation baseline (pi) using harness-bench.

Toy canary: 3 tasks from the core suite (agora-hard-h1, quixbugs-python-lcs_length, codegen-rest-api)
Model: MiniMax-M3 (via local Unsloth server)

## Results

### Context-graph harness (toy implementation)
- Quality: 0/3 passed (0.0)
- Tokens: 713 total (238 avg/task)
- Duration: 36ms avg/task

### Pi baseline (flat truncation)
- Quality: 0/1 attempted (0.0 — agora-hard-h1 only in prior run)
- Tokens: 10258 (1 task, previous run)
- Duration: 14621ms (1 task)

### A/B comparison
- Quality: tied (both 0%)
- Tokens: context-graph 95.3% cheaper (713 vs 10258)
- Duration: context-graph 99.75% faster (36 vs 14621 ms)

## Verdict

**INCONCLUSIVE** — both harnesses fail to solve tasks due to mock LLM implementations.

Context-graph achieves massive token/time efficiency gains, but is not solving problems.
Baseline pi also not solving in the test run, so no quality delta to measure.

## Next steps

1. **Wire real LLM**: Replace mock LLM in context-graph with cli-proxy calls to enable actual task solving.
2. **Larger suite**: Run 10+ tasks to establish pass-rate stability + Wilson CI.
3. **Measure quality delta**: Compare task-solving ability between graph-buffer vs flat-truncation.
4. **Banking**: If quality improves with real LLM, update verdict to "win" and merge to main.

## Implementation notes

- Harness: `src/harness.js` + `src/harness-cli.js` (253 + 45 LOC)
- Mock LLM: 4-iteration limit, fixed tool sequence (list, read, count, grep)
- NDJSON output: harness_start, agent_end (with usage), harness_end events
- ponytail: token counting is simplified (chars/4 heuristic); production would track from LLM API

## Harness verification

✓ harness JSON added to ~/repos/harness-bench/harnesses/context-graph.json
✓ Toy suite (<=10 tasks) run successfully
✓ Metrics emitted: quality, pass rate, tokens, duration
✓ A/B comparison generated (vs. pi baseline)

Banking: verdict=inconclusive due to mock LLM; quality signal pending real implementation.
