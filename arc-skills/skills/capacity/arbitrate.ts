// arbitrate.ts — P-CRIT: pure lane-aware verdict over an Estimate.
// ADVISORY ONLY. The caller (director binding, capacity.ts CLI) must fail-open:
// any error anywhere → treat as {action:"run", fail_open:true}. This module
// never throws on valid input and never blocks a critical dispatch.

import type { Estimate } from "./estimator.ts";

export type Lane = "critical" | "research" | "standard";

export type Verdict = {
  provider: string;
  action: "run" | "park" | "escalate";
  reason: string;
  headroom: { frac: number | null; capLB: number | null; windowHours: number | null; blocked: boolean };
  vast_stop: boolean;
  fail_open: boolean;
};

const FLOOR = 0.1; // ponytail: fixed headroom floor; promote to a binding knob when a director needs its own
const VAST_STOP_MIN = 30; // research lane parked ≥ this many minutes → signal vast_stop
const FEATHERLESS_CTX = 32_000;

export function arbitrate(
  est: Estimate,
  lane: Lane,
  opts: { ctx?: number; parkedMinutes?: number } = {},
): Verdict {
  const headroom = {
    frac: est.headroomFrac, capLB: est.capLB, windowHours: est.windowHours, blocked: est.blocked,
  };
  const v = (action: Verdict["action"], reason: string, vast_stop = false): Verdict =>
    ({ provider: est.provider, action, reason, headroom, vast_stop, fail_open: false });

  if (est.provider === "featherless" && (opts.ctx ?? 0) > FEATHERLESS_CTX)
    return v("park", `featherless ctx>${FEATHERLESS_CTX}`);

  const constrained = est.blocked || (est.headroomFrac !== null && est.headroomFrac < FLOOR);
  if (!constrained) return v("run", est.known ? "headroom ok" : "no capacity signal yet");

  const why = est.blocked ? "provider blocked (unresolved 429)" : "headroom below floor";
  if (lane === "critical") return v("escalate", why); // critical never parks
  const vastStop = lane === "research" && (opts.parkedMinutes ?? 0) >= VAST_STOP_MIN;
  return v("park", why, vastStop);
}
