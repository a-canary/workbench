# capacity — arcsim validation scorecard

Run 2026-07-07 · skill @ d72ab2c · image `arcsim-base:test` · harness
`arc-factory/bench/arcsim/run.sh` (hermetic, zero API calls) · seed 42 ·
results `~/vault/arcsim/capacity-r{1..5}.json`.

Protocol: 5 rounds, one change max per red gate, gates never lowered.

| Round | Scenario | Result | Key numbers |
|---|---|---|---|
| 1 | nominal 14d, both truths | **green** | cap recovery 0.993 / 0.997 (gate ≥0.85); window err 0h; critical SLO misses 0; research-park correctness 1.00; db-roundtrip ✓ |
| 2 | silent plan downgrade (5M→2.5M @ day 7) | **green** | recovery vs NEW cap 0.993 (gate 0.85–1.15) — trailing-7d max ages the old plan out; 37 blocks |
| 3 | full-day provider outage @ day 7 | **green** | 155 blocked evals: critical misses 0, research parks 1.00; window err 0h survives outage |
| 4 | weekly-cap week (40M) + 4× burst | **green** | weekly-class blocks detected (`weeklyCapLB` set); window err 0h |
| 5 | cold start, empty DB, 48h no 429s | **green** | all lanes `run`; `known:false` preserved; never park/escalate without signal |
| all | fail-open red line (broken DB → CLI) | **green ×5** | `{"action":"run","fail_open":true}` exit 0 every round |
| all | vast-stop latency | **green ×5** | fires at exactly 30 parked-minutes, not at 29 |

## Changes made (baseline → delta)

- **A3 unit gate (pre-arcsim), one change:** window inference from median
  429→success gap (recovery 0.58, window err 2h) → mode of refill-anchor
  deltas (recovery ≥0.99, err 0h). Gaps only bound the window — blocks land
  mid-window; refills land ON boundaries.
- **Rounds 1–5: zero changes.** No gate was re-scoped or lowered.

## Known ceilings (logged, not tuned — gates met)

- `capLB` can **overshoot** true cap after anchor drift: outage 1.12×, weekly
  4×-burst 1.28× (weekly resets don't land on window boundaries, so spend
  windows briefly straddle a true boundary). Treat `capLB`/`headroomFrac` as
  approximate; the floor check (0.1) absorbs this at current margins. Revisit
  only if a live director thrashes on false headroom.
- Estimator is hour-granular in validation; live traffic is finer — anchors
  only get better with real timestamps.
- Weekly `weeklyCapLB` is a lower bound from trailing-7d spend at weekly-class
  blocks; an outage is indistinguishable from weekly exhaustion from outside
  (both classify weekly — harmless: both mean "don't dispatch research here").
