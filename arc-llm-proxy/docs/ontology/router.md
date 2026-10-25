# auto-llm — adaptive router vocabulary & lifecycle

scope: auto-llm.ts
surveyed_at_sha: 3de26b5

Zoom level under [OVERVIEW.md](OVERVIEW.md). All line refs = auto-llm.ts @ 02dce8a.

## Vocabulary

- **Arm** — one candidate upstream model. Per-(class,arm) stats are `ArmStat {a,b}` beta counts (:124).
- **Class** — judge-assigned task bucket driving per-class Thompson state (`parseClass` :253; classes from `AutoCfg`).
- **Beta prior** — Beta(a,b) posterior per (class,arm); `gammaSample` :137, `betaSample` :150, `applyReward` :247.
- **Explore / exploit** — explore = Thompson sample (`pickArm` :172); exploit = deterministic top arm when its beta success exceeds the gate (`topArm` :212, `exploitPick` :233), capped at ~90% of traffic (EXPLOIT_SHARE / EXPLOIT_GATE).
- **Heat** — in-memory cache-heat LRU (`hot`, cap 4096, :450); a hot arm's effective price = price × cacheFactor in `costWeight` (:165). Marked hot on any upstream 200 (even denies — the provider processed the prefix either way).
- **B / attacker triage** — suspicious session → second judge pass → `Ruling` approve|heal|comment|deny (`parseRuling` :324) — comment = defect verdict; judge unreachable → fail-open approve tagged `down: true`. **Correction loop** (operator 2026-09-10: review must be invisible to the end user — advisory injections kept stalling panes): a confirmed comment redacts the flagged calls (`redactFlags`) and forwards [conversation + redacted response + review note (`reviewNote`/`buildCorrectionMessages`)] to a second TS generator, which re-attempts; its output is re-reviewed, up to `correctionRounds` (default 3) rounds. The turn always ends on the newest response — never user-visible review, never a stall. User-side delivery stays no-withhold (full calls ship if the loop exhausts); redaction lives only in the corrector forward. Being corrected impacts beta: `applyReward(false)` per corrected arm, `true` on final approval. Modes: `corrected` / `correction-failed`. **Comment-confirmation gate** (2026-09-10: three comments in 4 min, all false — trusted pair said approve, operator confirmed the flagged model was real): a comment only corrects when `trustedJudge` agrees; a trusted approve/heal overrides to approve (`commentCleared` :184) — delivered as-is (`comment-overruled`); every escalation logs its pair; arm == trustedJudge skips (lineage); trusted-down never clears (fail safe → correct). **Trusted judge**: ~5% of explore turns also re-graded by `trustedJudge` (`ali/qwen3.8-max`, paid ~$4/M blend, under $1/day; free fallback `z-ai/glm-5.3-free` when its provider is re-enabled) — paired verdicts in `trusted: "cheap/trusted"` judge the judge POOL, not the turn; failed judge calls log `down`, never agreement. Zero reward/delivery impact on sampled turns (`trustedSample` :177).
- **L0** — deterministic tool-call heal: unparseable names/JSON args fixed or counted invalid (`healToolCalls` :374 → `{calls, healed, invalid}`; JSON unwrap depth cap 4 :382; "developer"→"system" role normalize :711; `toolSummary` :415).
- **P1** — degeneracy gate on ALL traffic, pre-delivery: empty/leak/bad-tool-call (`gateReason(text, callCount, invalid)` :45). Gate-reject rewards false (a degenerate 200 is a quality failure).
- **P2 / hold-back** — `pumpStream` buffers all deltas; `finishSse` replays held tail + toolCalls only after the verdict, so a deny guarantees nothing reached the client; deny = full redact + resample (`AutoLlm` class :429).
- **Pricing** — observed $/1M with market fallback (`matchMarketId` :299, `buildPriceMap` :318); flat price×cacheFactor for hot arms, no input/output split (ponytail: prompt tokens ≈99% of agent-turn cost).

## Request lifecycle (one auto-llm turn)

1. POST :8091 → `authUser` → alias `auto-llm` → `autoLlm.handle` (server.ts :852 mount).
2. Classify via cfg.judge: `lastUserText` :340, `normalizeMessages` :364, `parseClass` :253.
3. L0 heal (`healToolCalls` :374).
4. Arm pick: exploit path if top beta > 0.99 gate (≤90% share), else `pickArm` — beta sample × `costWeight`, hot arms discounted by cacheFactor.
5. Forward to 9router upstream; arm fail → next arm; per-user `errs` cooldown (memory) + global exponential backoff: provider-side failures (0, 402/404/408/410/429, 5xx) double a 3s penalty to a 3-day cap, any 200 resets (`providerSideErr`/`backoffDelay` :189); 400/401/403 stay per-user — never hard-disable.
6. P1 `gateReason` :45 → reason ⇒ B triage `parseRuling` :324 (approve/heal/comment/deny).
7. P2 hold-back: buffer → replay or full-redact; `applyReward` :247 → save ts-state.json.
8. Audit row + price observation (`buildPriceMap` :318).

## Config surface

- `AutoCfg` (:90): arms, pretrain, judge, classes, judgeMaxTokens, stateFile, logFile, cooldownMs, maxRetries, unknownClass, keyFile, trustedJudge, trustRate, backoffMinMs, backoffCapMs.
- `PriceCfg` (:111): alpha, cacheFactor (0.5), cacheTtlMs (30 min), market fallback TTL 24h.
- Live config: `deploy/auto-llm.json` (hot values; ts-state hot-reloads on mtime change).