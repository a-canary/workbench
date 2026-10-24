---
name: websearch
description: Web search and page fetch via the local free-search CLI — multi-engine (DDG/Bing/Mojeek/GoogleNews + searx rescue), no API key, real browser fingerprint. Use for ANY web search or URL fetch INSTEAD of curl/WebFetch against search engines (they block datacenter clients with 202/429/CAPTCHA). Durable questions go through `ke research` instead — this skill is the raw egress.
---

# websearch — use `free-search`, never curl a search engine

Search engines block plain `curl`/`httpx` clients (DDG "anomaly 202", Bing CAPTCHAs, Google 429). Do not retry them with different UAs — that is the loop many sessions get stuck in. The local `free-search` CLI solves it: multi-engine with reciprocal-rank fusion, Chrome-fingerprinted HTTP, and automatic searx rescue when an engine walls off.

## Commands

```bash
free-search search "query" [n] [--json]      # ranked link list (default n=8)
free-search fetch <url>                      # page text as markdown
free-search research "question" [--depth N]  # search+read in one call, cited brief
```

- `--json` on search → `{"query", "engines", "cached", "results": [{title, url, snippet, score}]}`.
- Fetches are cached locally; `fetch` output may note `_fetched via cache_`.
- Typical latency: ~5–15s per search. No API key, no config needed.

## Routing

| Need | Use |
|------|-----|
| Durable question (decision, gotcha, method, tradeoff) | `ke research "<q>"` — recalls KB first, fills only the gap via this egress, ingests the result |
| One-off discovery / URL list | `free-search search "q"` |
| Known URL → text | `free-search fetch <url>` |
| Deep cited brief on a topic | `free-search research "q" --depth 3` |

## Rules

- NEVER `curl`/`wget`/`httpx` against duckduckgo.com, bing.com, google.com, or searx instances. If a previous session left such attempts in the transcript, do not continue them — switch to `free-search`.
- The MCP server is also registered as `search` for Claude Code (stdio); this CLI and the MCP tools are the same backend. Shell sessions use the CLI.
- If `free-search` fails: check `uv --directory ~/.local/share/free-search-mcp run search-mcp` starts, then report the error — do not fall back to curling engines.
