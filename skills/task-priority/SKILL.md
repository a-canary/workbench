---
name: task-priority
description: When two concerns conflict, sort by UX > quality > security > scale > efficiency. Higher always wins.
---

# task-priority

Engineering decisions are usually trade-offs between concerns that all sound reasonable. This skill defines the tiebreaker order.

## The order

```
UX  >  quality  >  security  >  scale  >  efficiency
```

| Tier | What it covers |
|---|---|
| **UX** | Does the user get what they wanted, fast, without confusion? |
| **quality** | Is the code correct, tested, maintainable? Does it fail loudly when it fails? |
| **security** | Does it protect the user's data, credentials, and machine? |
| **scale** | Will it survive 10× / 100× the current load? |
| **efficiency** | Tokens, CPU, memory, dollars. |

**Higher always wins in a tiebreaker.** Not by a small margin — completely.

## Why this order

- **UX first** because a fast, correct, secure system nobody can use has zero value.
- **Quality before security** because insecure correct code is fixable; secure broken code looks fine and rots.
- **Security before scale** because a breach at small scale is still a breach.
- **Scale before efficiency** because a system that falls over at 10× load is broken, but a system that's 2× too expensive is just expensive.
- **Efficiency last** because it's the easiest to optimize later and the hardest to optimize prematurely.

## How to apply

When you find yourself writing "but this is more efficient" or "this scales better," ask: at what cost to the rung above? If any cost: don't do it.

When you find yourself writing "this is harder to use but more secure": that's allowed. Higher beats lower.

## Common conflicts

| Conflict | Resolution |
|---|---|
| "Pre-allocate to avoid GC" vs readable code | Quality wins. Profile before complicating. |
| "Encrypt at rest" vs "ship today" | Security wins. Slip the date. |
| "Parallel pipeline" vs "obvious sequential" | Quality wins unless scale is proven needed. |
| "Cache aggressively" vs "stale data risk" | UX wins. Stale data is broken UX. |
| "Strict input validation" vs "developer ergonomics" | Security wins. Validate. |

## When NOT to use this skill

- The conflict is between two same-tier concerns (two UX trade-offs). Then use judgment, not this skill.
- The decision is irreversible and you should be asking the user, not running the ladder.

## Anti-pattern

Quoting the ladder as justification for a decision the user didn't ask for. The ladder breaks ties; it doesn't manufacture work. If nothing is in conflict, don't optimize anything.
