// Oolong-shaped realistic task: a corpus of support tickets, and a question
// that can only be answered by classifying EVERY ticket and aggregating.
//
// Why this shape rather than RULER FWE: FWE counts word frequencies, which is
// not a task anyone has. This is — triage a ticket backlog and report a
// distribution. It keeps the two properties that make FWE usable as a gate
// (self-generating, exact-match scored, unanswerable from top-k) while being
// an actual analytical job. See docs/eval.md §2.
//
// ponytail: templated tickets, not an LLM-generated corpus. Generating the
// corpus with a model would make the eval depend on the thing under test.

export type Task = {
  prompt: string;
  question: string;
  units: string[]; // per-unit texts, for the decomposed pipeline
  truth: boolean[]; // per-unit ground truth, aligned to units — for error diagnosis
  answer: number; // ground-truth count
  label: string; // what is being counted
};

const PRODUCTS = ["Checkout", "Billing", "Search", "Inbox", "Reports", "Mobile"];
const SEVERITY = ["low", "normal", "high", "urgent"];
const ACTORS = ["a new customer", "an enterprise admin", "a trial user", "a returning customer"];

// The classification target. Only BILLING-CAUSED failures count — a ticket can
// mention billing without being caused by it, so substring matching fails.
export const BILLING_CAUSE = [
  "was charged twice for the same subscription period",
  "saw the invoice total differ from the quoted price",
  "had a payment method silently declined without notice",
  "was billed after cancelling the plan",
  // r43: boundary cases. Billing-caused, but the surface story is a service
  // failure — tests generalization beyond the four canonical phrasings.
  "was locked out of the account after a card expiry was mishandled",
  "lost access to paid features when a renewal charge posted to the wrong plan",
  "received a refund for less than the amount actually taken",
];
const OTHER_CAUSE = [
  "could not upload an avatar larger than 2MB",
  "saw search results ranked in the wrong order",
  "hit a timeout when exporting a large report",
  "found the mobile layout clipped on small screens",
  "reported that notification emails arrived hours late",
  // Deliberate distractors: mention billing, not caused by it.
  "asked where to find the billing settings page",
  "requested a copy of last year's invoices for accounting",
  // r43: boundary cases the other way — a paying customer inconvenienced by a
  // service fault, which r37 showed the model is tempted to call a billing fault.
  "was unable to download a receipt because the export job kept failing",
  "saw the subscription page load slowly during a traffic spike",
  "could not reach support through the in-app chat widget",
];

/**
 * r52: harder arm. r51 established corpus SIZE is exhausted as a difficulty
 * lever — 80 units and 320 units both score 0.0-0.4% countErr, because the
 * census decomposes per unit and unit count barely registers. The remaining
 * lever is per-unit AMBIGUITY: cases where the billing/not-billing call is
 * genuinely contestable rather than a phrase lookup.
 *
 * These are labelled by ROOT CAUSE, matching the r47 question definition:
 * billing-caused means the customer's money or payment method was mishandled,
 * whatever the surface symptom. Each pair below is deliberately near-identical
 * on the surface and opposite underneath.
 */
const HARD_BILLING = [
  "was downgraded to the free tier because a valid card was wrongly flagged as expired",
  "saw a discount code silently dropped so the charge came in above the agreed rate",
  "had a duplicate refund clawed back twice, leaving the account short",
  "lost premium support after a proration error zeroed the seat count",
];
const HARD_OTHER = [
  "was downgraded to the free tier after an admin removed their own seat by mistake",
  "saw a discount banner keep displaying after the promotion had properly ended",
  "had a refund arrive later than the advertised window but for the correct amount",
  // r53: "lost premium support after the plan was intentionally changed by
  // their finance team" lived here and scored 5/10 in isolation even after the
  // definition was tightened — at temperature 0 across ten trials, that is the
  // model failing to resolve it either way, which makes it an ambiguous ITEM,
  // not a hard one. A benchmark item whose own author needs two attempts to
  // word is measuring the wording. Removed rather than tuned around; the pair's
  // billing side ("proration error zeroed the seat count") keeps its partner in
  // "lost premium support after ..." below.
  "lost premium support when the account was merged into a parent organisation",
];

/**
 * r66 showed the corpus has only 25 distinct summary phrases, the same 25 in
 * every seed, so n=2880 unit judgments were 25 decisions replicated ~115x and
 * every CI since r58 was overconfident. These add 24 more (12 each side) to
 * make the phrase-level n large enough to measure with.
 *
 * r53's constraint governs every one of them: an item whose own author needs
 * two attempts to word is measuring the wording, not the model. Each phrase
 * below is one whose label I can state without hesitating, under the same
 * definition the question uses — something went WRONG in the handling of the
 * customer's money, whatever the surface symptom.
 *
 * WIDE=1 mixes these in; default off so every r43-r66 round stays comparable.
 */
const WIDE_BILLING = [
  "was charged the annual rate after selecting the monthly plan",
  "had a coupon applied at the wrong percentage so the total came out high",
  "was charged in the wrong currency at an unfavourable conversion",
  "had a failed payment retried four times, each attempt fee-charged",
  // r67: "was moved to a higher tier by a pricing migration they never agreed
  // to" was here and scored 4/10 in isolation, and it was MY label that was
  // wrong: a vendor raising prices is a commercial decision the customer
  // dislikes, not a mishandling of their money. Same class as r43/r47/r53 —
  // question and label disagreeing, the model scored wrong for following the
  // question. Removed rather than reworded.
  "had a card charged again after the subscription was already paid by invoice",
  // Boundary the r43 way: billing-caused, service-shaped surface.
  "lost API access when a chargeback was applied to the wrong account",
  "found seats removed after a partial payment was misapplied",
  "was locked out mid-session when an expired card blocked a mid-cycle renewal",
  "had exports disabled because a credit note was posted as a debit",
  "saw their trial end early after a prepayment was credited elsewhere",
  // r67: "lost saved reports when a failed renewal downgraded the workspace"
  // was here, 4/10 in isolation, same author error — a renewal that genuinely
  // fails (expired card, no funds) is the system working correctly, so YES was
  // not defensible. Its OTHER-side twin ("admin deleted the workspace") stays:
  // it is unambiguous alone and still tests the downgrade surface.
];
const WIDE_OTHER = [
  "could not sort a table by a custom column",
  "found the dark mode toggle reset on every reload",
  "had a webhook deliver events out of order",
  "saw stale data after switching workspaces",
  "could not invite a teammate whose email had a plus sign",
  "hit a rate limit while bulk-importing contacts",
  // Distractors: mention money, not caused by a billing fault.
  "asked whether annual plans can be paid by bank transfer",
  "requested a breakdown of which seats each invoice line covers",
  // Near-misses against WIDE_BILLING above, correct-execution side.
  // r67: partner of the removed pricing-migration item; a pair with one side
  // gone tests nothing, so both leave together.
  "had a card charged again because they resubscribed deliberately",
  "saw their trial end on the advertised date with no extension offered",
  "lost saved reports after their own admin deleted the workspace",
];

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}
const pick = <T,>(r: () => number, a: T[]) => a[Math.floor(r() * a.length)];

/**
 * `n` tickets; question asks how many were caused by a billing fault.
 * `hard` mixes in the near-miss pairs above — see HARD_BILLING.
 * ponytail: one corpus with a dial, not two task types. Two generators would
 * drift and stop being comparable, which is the whole point of the arm.
 */
export function makeTask(seed: number, n: number, hard = false): Task {
  const wide = process.env.WIDE === "1";
  const billingPool = [
    ...BILLING_CAUSE,
    ...(hard ? HARD_BILLING : []),
    ...(wide ? WIDE_BILLING : []),
  ];
  const otherPool = [
    ...OTHER_CAUSE,
    ...(hard ? HARD_OTHER : []),
    ...(wide ? WIDE_OTHER : []),
  ];
  const rnd = lcg(seed);
  const units: string[] = [];
  // Per-unit ground truth. The total alone can't say WHICH unit a run misjudged,
  // and the residual ~0.5% count error is roughly one unit per two runs — too
  // few to diagnose from aggregates. See docs/eval.md §8.
  const truth: boolean[] = [];
  let answer = 0;

  for (let i = 0; i < n; i++) {
    const billing = rnd() < 0.25;
    if (billing) answer++;
    truth.push(billing);
    const cause = billing ? pick(rnd, billingPool) : pick(rnd, otherPool);
    units.push(
      `Ticket #${1000 + i}\n` +
        `Product: ${pick(rnd, PRODUCTS)}\n` +
        `Severity: ${pick(rnd, SEVERITY)}\n` +
        `Reported by: ${pick(rnd, ACTORS)}\n` +
        `Summary: The customer ${cause}.\n` +
        `Status: ${rnd() < 0.5 ? "open" : "closed"}`,
    );
  }

  const question =
    `How many of these tickets describe a problem CAUSED BY A BILLING FAULT ` +
    // r47: this was a closed list of five charge events. The r43 boundary cases
    // are billing faults whose SURFACE is a service failure ("locked out after a
    // card expiry was mishandled") and match none of the five, so the model
    // answered NO correctly and the ground truth was wrong. Stated as a
    // definition with the list as examples, not as the whole set.
    // r53: isolation scored "plan intentionally changed by their finance team"
    // 1/10 — the model called it billing, and by the definition below it was
    // RIGHT: this said "the handling of the customer's money", which a
    // deliberate customer-initiated plan change plainly is. The label said
    // otherwise, so my label and my question disagreed and the model was scored
    // wrong for following the question. Same defect as r47. The headline already
    // said FAULT; the definition now says it too — something must have gone
    // WRONG, and a correctly-executed intentional change has not.
    `(anything whose root cause is something going WRONG in the handling of the ` +
    `customer's money or payment method — charges, refunds, payment methods, ` +
    `renewals. A change the customer or their own staff deliberately requested, ` +
    `carried out correctly, is NOT a fault — e.g. charged ` +
    `the wrong amount, charged twice, charged a price differing from the quote, a ` +
    `payment declined or mishandled, or charged after cancelling)? ` +
    `Tickets that merely mention billing — asking where settings are, or requesting ` +
    `invoice copies — do NOT count.\n\n` +
    `Answer with a single integer and nothing else.`;

  return {
    prompt: `Below is a support ticket backlog.\n\n${units.join("\n\n")}\n\n${question}`,
    question,
    units,
    truth,
    answer,
    label: "billing-caused tickets",
  };
}

/**
 * Is this unit billing-caused, per its text? The single source both the
 * generator's labels and the tests' independent check derive from — r43 showed
 * a hand-copied regex silently goes stale when the cause lists grow, and the
 * r52 hard arm grows them again.
 */
export const isBillingCaused = (unit: string) =>
  [...BILLING_CAUSE, ...HARD_BILLING, ...WIDE_BILLING].some((c) => unit.includes(c));

/**
 * How many DISTINCT summary phrases a corpus can draw on — the real n behind
 * unitAcc. r66: 80 units off a 25-phrase pool is 25 decisions replicated ~3.2x
 * per seed, and the same 25 in every seed, so pooling seeds does not add
 * independent trials. Reported beside unitN so the two are never confused again.
 */
export const phrasePoolSize = (hard: boolean, wide: boolean) =>
  BILLING_CAUSE.length +
  OTHER_CAUSE.length +
  (hard ? HARD_BILLING.length + HARD_OTHER.length : 0) +
  (wide ? WIDE_BILLING.length + WIDE_OTHER.length : 0);

/** Exact-match on the integer. Takes the last integer: models often reason first. */
export function scoreTask(reply: string, answer: number): number {
  const nums = reply.match(/-?\d+/g);
  if (!nums) return 0;
  return Number(nums[nums.length - 1]) === answer ? 1 : 0;
}

/**
 * Relative count error, the hillclimbed quantity.
 *
 * Exact-match is unusable as the scored axis here: three identical runs of
 * seed 1000 returned 11, 9 and 10 against a truth of 12, so one seed flipping
 * moves a 5-seed exact-match score by a full 20 points and swamps any real
 * change. Count error moves smoothly with accuracy, so a 5-seed round is
 * legible. See docs/eval.md §6. Exact-match is retained above as a secondary
 * report, not the thing being climbed.
 */
export function countError(reply: string, answer: number): number {
  const nums = reply.match(/-?\d+/g);
  if (!nums) return 1;
  return Math.min(1, Math.abs(Number(nums[nums.length - 1]) - answer) / Math.max(1, answer));
}

/**
 * Wilson score interval for a binomial proportion, returned as [lo, hi].
 *
 * Terminal-Bench reports accuracy as "83.8% ± 1.2%", and that CI is what makes
 * two leaderboard rows comparable — a bare percentage off a handful of trials
 * is not a claim anyone can check. This bench was reporting bare percentages
 * off 3-5 seeds against a measured ±3pt noise floor, which is exactly the
 * failure mode a CI exists to expose. See docs/eval.md §7.
 *
 * Wilson rather than normal-approximation: at n=5 with p near 0 or 1 the normal
 * approximation produces intervals outside [0,1], which is nonsense on its face.
 */
export function wilson(hits: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}
