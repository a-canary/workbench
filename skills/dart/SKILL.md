---
name: dart
description: Frame the system before you act. Run a DART pass (Deconstruct, Analyze, Recognize, Test) + a systems-thinking lens before debugging, designing, or reviewing — so you fix the structure, not the symptom. Use when starting a debug/design/review, when a bug keeps coming back, or when the user says "DART", "systems thinking", or "frame this".
---

# DART — frame before you fix

Most expensive mistakes come from a **wrong mental model of the system**, not weak execution. You act, the effect shows up later (delay), and you've already moved on. This skill is a gate: spend a few minutes building the right model *before* you touch the system.

Run it at three moments: **before debugging**, **before designing/architecting**, **before reviewing**. Same lens, different emphasis.

## The gate: DART

A diagnostic to figure out *which kind of system you're in* before you pick a move. Real problems don't come with labels.

- **D — Deconstruct.** Break the problem into subparts. What is the system actually made of? Are the parts **stable** or **constantly shifting**? Name the stocks (where state piles up) and flows (what fills/drains them).
- **A — Analyze (the key step).** What is the link between **cause and effect**? This single question classifies the system:
  - obvious -> **Clear**
  - hidden but discoverable by analysis -> **Complicated**
  - only knowable in hindsight, emergent, shifting -> **Complex**
  - broken / no link -> **Chaotic**
- **R — Recognize.** Seen this before? Exact pattern, or *similar* in any other system. Match within and across systems (archetypes, anti-patterns, past incidents).
- **T — Test.** Run the **smallest** test that could falsify your model before committing to a full response. (Exception: in a Chaotic system there's no time — stabilize first.)

## Match the move to the system (Cynefin)

| System | Cause->effect | Move |
|---|---|---|
| **Clear** | obvious | follow the known process / runbook / checklist; don't improvise |
| **Complicated** | hidden, discoverable | slow down, analyze, profile, get the right expert |
| **Complex** | hindsight-only, emergent | run many small probes, stay adaptable, course-correct; no big-bang |
| **Chaotic** | broken | act first — stabilize (rollback, feature-flag, shed load), create safety, *then* diagnose |

Biggest failure mode in Chaotic: analysis paralysis — wanting the full picture before acting. Biggest failure mode everywhere else: acting like it's Clear when it isn't.

## The systems lens (use during D and A)

- **Iceberg — descend before you fix.** Events (this incident) -> Patterns (does it recur?) -> Structure (rules/processes/feedback that hold the pattern) -> Mental models (beliefs that built the structure). An event-level fix is a bandage. Ask: *"what structure made this failure inevitable?"* not *"what broke?"*
- **Stocks & flows (bathtub).** Bugs / tech-debt / backlog are stocks that accumulate. Rushed features = inflow; refactor, tests, fixes = outflow. If inflow > outflow, the tub overflows — no single fix helps until you change the rates.
- **Feedback loops.** Reinforcing (amplifies — retry storms, debt begetting debt, snowballing load) vs balancing (self-corrects toward a goal — autoscaling, backpressure, rate limits). A problem that returns after every fix is a loop, not bad luck. Find the loop.
- **Delays.** Cause and effect separated in time hides the real driver and invites overcorrection. Look for the lagged input.
- **Emergence.** System behavior exceeds the sum of parts; it lives in the *interactions*. Reason about component interplay (retries, thresholds, contention) before debugging any one component in isolation.
- **Information flows = cheap leverage.** Missing/stale/wrong feedback is one of the most common malfunctions. Ask: *what signal is missing, late, or lying?* Adding the right metric/log/alert often beats a code change.
- **Leverage points.** Weak interventions: tweak numbers/params/configs. Strong: change feedback structure, goals, the mental model. Leverage is **counterintuitive** — people push it backward (tune a constant when the goal is wrong). Ask: *at what level am I intervening — and is there a deeper one?* (Don't assume a fixed ranking of the middle points; just know params are weak and goals/paradigms are strong.)

## Before DEBUGGING — checklist

1. **Reproduce + classify (A):** is cause->effect obvious (Clear -> known fix), discoverable (Complicated -> profile/analyze), emergent (Complex -> probe), or broken/prod-down (Chaotic -> stabilize first)?
2. **Event or pattern? (Iceberg):** first time, or recurring? Recurring -> hunt the structure/loop, not this instance.
3. **What structure made this inevitable?** What feedback loop, delay, or stock-overflow produced it?
4. **Interactions, not parts (emergence):** which component *interplay* is implicated before you blame one module?
5. **What information is missing?** Can you add a signal that makes the cause observable? Build that feedback loop first.
6. **Smallest test (T):** what one probe falsifies your top hypothesis?

## Before DESIGNING / ARCHITECTING — checklist

1. **Deconstruct (D):** subparts; which are stable vs likely to shift? Design the shifting ones for change.
2. **Stocks & flows:** what accumulates (queues, state, debt)? Are inflow/outflow rates balanced under load, or does something overflow?
3. **Loops & delays:** where are the reinforcing loops (runaway risk) and balancing loops (backpressure, limits, autoscaling)? Where do delays hide?
4. **What system am I in (A)?** Complicated (design up front) vs Complex (build to probe + evolve — tracer bullets, reversible decisions).
5. **Leverage / goal:** what is this system's actual goal, and does the structure serve it? Cheapest high-leverage lever = the right information flow.
6. **Recognize (R):** which known architecture/pattern is this? What killed it last time?
7. **Integration & evolution:** what else must it integrate with; how does it absorb growth in users/data/tech?

## Before REVIEWING a system — checklist

1. **See the whole, not the diff:** what system does this change live in; what does it touch?
2. **Iceberg:** is the change patching an event, or addressing the structure? Is it bandaging a recurring pattern?
3. **Recognize (R):** known anti-pattern? Same mistake the last incident taught?
4. **Loops & second-order effects:** what feedback does this change create or break? What happens at scale / under failure?
5. **Information flows:** does it leave the system observable — can you tell, in prod, whether it works?
6. **Leverage:** is this the weakest intervention (param tweak) where a structural fix was needed — or vice-versa?

## Get on the platform (outside view)

You can't see the loop you're standing inside (the train-beside-you illusion). Three ways out, fast:
- **Mentors** — someone with no stake in your story.
- **Data** — what the system *actually* does vs what you believe it does.
- **Time** — compare to a week/month/year ago; trend over snapshot.

## Don't overclaim

- Params are weak leverage, goals/paradigms are strong — but there's **no validated strict ordering** of the middle points. Don't assert "goals > information flows > ...".
- Changing the goal is **not** universally "THE most powerful lever." Depends on the system.
- Systems thinking is **not** a fixed list of exactly N concepts to tick. The lenses above are tools, not a schema.
