# eBay — viewing listings

Credentials: pass `ebay/dev-app-id` (App ID) + `ebay/cert-id` (Cert ID);
env `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` override. Production keyset —
the sandbox returns fake listings.

## Item detail (the working method)

Client-credentials only, no user token, no browser. The Browse item endpoint
requires the VERSIONED itemId `v1|<id>|0` — a bare numeric id always 404s
with errorId 11001 "item not found" even when the listing is live. That red
herring is how a previous session concluded live listings were dead.

```js
// token: POST https://api.ebay.com/identity/v1/oauth2/token
//   Basic auth from pass, grant_type=client_credentials,
//   scope=https://api.ebay.com/oauth/api_scope
const r = await fetch(
  `https://api.ebay.com/buy/browse/v1/item/v1%7C${id}%7C0?include=description,shippingOptions`,
  { headers: { Authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } },
);
// -> 200 { title, price:{value,currency}, condition, buyingOptions,
//          seller:{username,feedbackScore,feedbackPercentage}, itemLocation,
//          shippingOptions, image, additionalImages, itemWebUrl, description(HTML),
//          legacyItemId, listingMarketplaceId }
```

CLI: `node ~/repos/arc-shopper/sources/ebay-item.mjs <itemId | ebay.com/itm/... URL> [--json]`

## Search

`node ~/repos/arc-shopper/sources/ebay.mjs "<query>" [--min N] [--max N] [--used] [--zip 40245] [--radius 150] [--auction] [--json]`

Endpoint: `GET /buy/browse/v1/item_summary/search`. Works fine. Search
results already carry the versioned `itemId` (`v1|<id>|0`) — pass it
straight to the detail endpoint.

## Gotchas

- **11001 = wrong id form, not a dead listing.** Use versioned `v1|<id>|0`.
  If a versioned id 404s, the item is likely ended — re-find it by title via
  search.
- **svcs.ebay.com is dead** (404 at root) — legacy Shopping / Finding /
  Trading APIs are retired. Don't chase them.
- **HTML fetch is IP-blocked**: `ebay.com/itm/...` → 403 captcha, even via
  playwright headless chromium. No cookie/UA workaround found.
- **Quota**: 1000 item calls/day on the dev app. Detail-fetch only listings
  you act on, not every search row.
