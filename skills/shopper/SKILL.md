---
name: shopper
description: "View and verify live marketplace listings (eBay) — item detail with client-credentials only, search, and the versioned-ID gotcha. Use when asked to check whether a listing is live, read a listing's price/condition/seller/description, or find purchase options for a watchlist item."
---

# shopper

Read live marketplace listings the way an agent can: first-party API, no
scraping. ebay.com HTML is 403 bot-blocked from this box (even headless
chromium — IP-level), so the Browse API is the only sanctioned view.

- **eBay** — [ebay.md](ebay.md): item-detail recipe (versioned IDs), search,
  credentials, the 11001 gotcha.
- Working code lives in `~/repos/arc-shopper/sources/` — `ebay.mjs` (search),
  `ebay-item.mjs` (item detail). Reuse it; don't re-derive it.
