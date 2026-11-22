import { readFileSync, statSync } from "node:fs";
// Control pane shell (slice B1). Public framework: no repo, seat or
// mission names in code; personal paths come from <config dir>/pane.json.

// cards with a verdict being written right now, so two submits at the same moment write one verdict
const inFlight = new Set<string>();

export const PLACES = ["inbox", "feed", "seats", "work", "vision"] as const;

export type Run = (args: string[]) => Promise<{ code: number; out: string }>;

export type Card = {
  id: string;
  title: string;
  priority: number;
  updated: string;
  source: string;
  description?: string;
  skipped?: true;
};

export const bdRun: Run = async (args) => {
  const proc = Bun.spawn(["bd", ...args], { stdout: "pipe", timeout: 15000 });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
};

export function loadConfig(dir: string): { beadDirs: string[]; hosts?: string[]; failuresFile?: string } {
  const path = `${dir}/pane.json`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`missing config: ${path}`);
  }
  let cfg: unknown;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new Error(`bad pane.json: ${path}: invalid JSON`);
  }
  if (
    cfg === null ||
    typeof cfg !== "object" ||
    !Array.isArray((cfg as { beadDirs?: unknown }).beadDirs) ||
    (cfg as { beadDirs: unknown[] }).beadDirs.some((d) => typeof d !== "string")
  ) {
    throw new Error(`bad pane.json: ${path}: beadDirs must be an array of strings`);
  }
  const obj = cfg as { beadDirs: string[]; hosts?: unknown; failuresFile?: unknown };
  if (obj.hosts !== undefined) {
    if (!Array.isArray(obj.hosts) || obj.hosts.some((h) => typeof h !== "string")) {
      throw new Error(`bad pane.json: ${path}: hosts must be an array of strings`);
    }
  }
  if (obj.failuresFile !== undefined && typeof obj.failuresFile !== "string") {
    throw new Error(`bad pane.json: ${path}: failuresFile must be a string`);
  }
  const result: { beadDirs: string[]; hosts?: string[]; failuresFile?: string } = { beadDirs: obj.beadDirs };
  if (obj.hosts !== undefined) result.hosts = obj.hosts;
  if (obj.failuresFile !== undefined) result.failuresFile = obj.failuresFile;
  return result;
}

export function allowedHosts(
  cfg: { hosts?: string[] },
  host: string,
  port: number
): string[] {
  if (cfg.hosts && cfg.hosts.length > 0) {
    return cfg.hosts.map((h) => h.toLowerCase());
  }
  // No list configured: the bound address and this machine's local names. A pane reached by any
  // other name (a machine name, or any address when bound to all of them) needs `hosts` in pane.json.
  return [...new Set([`${host}:${port}`.toLowerCase(), `localhost:${port}`, `127.0.0.1:${port}`])];
}

export function parsePort(v: string | undefined): number {
  if (v === undefined) return 8081;
  if (!/^[0-9]+$/.test(v)) {
    throw new Error(`PORT must be a number from 1 to 65535, got "${v}"`);
  }
  const n = Number(v);
  if (n < 1 || n > 65535) {
    throw new Error(`PORT must be a number from 1 to 65535, got "${v}"`);
  }
  return n;
}

export async function loadCards(
  dirs: string[],
  run: Run = bdRun,
  now: number = Date.now()
): Promise<{ cards: Card[]; errors: string[] }> {
  const errors: string[] = [];
  const seen = new Set<string>();
  const cards: Card[] = [];

  const results = await Promise.all(
    dirs.map(async (dir) => {
      try {
        const result = await run(["-C", dir, "human", "list", "--json"]);
        if (result.code !== 0) {
          return { dir, error: `${dir}: bd exited ${result.code}` };
        }
        let items: unknown[];
        try {
          items = JSON.parse(result.out);
          if (!Array.isArray(items)) throw new Error("not an array");
        } catch {
          return { dir, error: `${dir}: bad JSON from bd` };
        }
        return { dir, items };
      } catch {
        return { dir, error: `${dir}: bd could not run` };
      }
    })
  );

  for (const r of results) {
    if ("error" in r) {
      errors.push(r.error);
      continue;
    }
    let invalid = 0;
    for (const raw of r.items) {
      if (
        raw === null ||
        typeof raw !== "object" ||
        typeof (raw as Record<string, unknown>).id !== "string" ||
        typeof (raw as Record<string, unknown>).title !== "string" ||
        typeof (raw as Record<string, unknown>).priority !== "number" ||
        typeof (raw as Record<string, unknown>).updated_at !== "string"
      ) {
        invalid++;
        continue;
      }
      const item = raw as Record<string, unknown>;
      // A skipped card is deferred until now, so a due deferred card is still waiting.
      const skipped =
        item.status === "deferred" &&
        typeof item.defer_until === "string" &&
        Date.parse(item.defer_until) <= now;
      if (item.status !== "open" && item.status !== "in_progress" && !skipped) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      cards.push({
        id: item.id,
        title: item.title,
        priority: item.priority,
        updated: item.updated_at,
        source: r.dir,
        ...(skipped ? { skipped: true as const } : {}),
        ...(typeof item.description === "string"
          ? { description: item.description }
          : {}),
      });
    }
    if (invalid > 0) {
      errors.push(`${r.dir}: ${invalid} malformed items skipped`);
    }
  }

  cards.sort((a, b) => {
    if (a.skipped !== b.skipped) return a.skipped ? 1 : -1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.updated.localeCompare(b.updated);
  });

  return { cards, errors };
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type Landed = {
  id: string;
  title: string;
  kind: string;
  closed: string;
  reason: string;
  source: string;
};

export async function loadLanded(
  dirs: string[],
  run: Run = bdRun,
  now: number = Date.now(),
  days: number = 3
): Promise<{ items: Landed[]; errors: string[] }> {
  const since = new Date(now - days * 86400000).toISOString();
  const errors: string[] = [];
  const seen = new Set<string>();
  const items: Landed[] = [];

  const results = await Promise.all(
    dirs.map(async (dir) => {
      try {
        const result = await run([
          "-C", dir, "list", "--status", "closed",
          "--closed-after", since, "--limit", "0", "--json",
        ]);
        if (result.code !== 0) {
          return { dir, error: `${dir}: bd exited ${result.code}` };
        }
        let rows: unknown[];
        try {
          rows = JSON.parse(result.out);
          if (!Array.isArray(rows)) throw new Error("not an array");
        } catch {
          return { dir, error: `${dir}: bad JSON from bd` };
        }
        return { dir, rows };
      } catch {
        return { dir, error: `${dir}: bd could not run` };
      }
    })
  );

  for (const r of results) {
    if ("error" in r) {
      errors.push(r.error);
      continue;
    }
    let invalid = 0;
    for (const raw of r.rows) {
      if (
        raw === null ||
        typeof raw !== "object" ||
        typeof (raw as Record<string, unknown>).id !== "string" ||
        typeof (raw as Record<string, unknown>).title !== "string" ||
        typeof (raw as Record<string, unknown>).closed_at !== "string" ||
        // The feed prints the day and time straight from this value.
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test((raw as Record<string, unknown>).closed_at as string)
      ) {
        invalid++;
        continue;
      }
      const row = raw as Record<string, unknown>;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      items.push({
        id: row.id,
        title: row.title,
        kind: typeof row.issue_type === "string" ? row.issue_type : "",
        closed: row.closed_at,
        reason: typeof row.close_reason === "string" ? row.close_reason : "",
        source: r.dir,
      });
    }
    if (invalid > 0) {
      errors.push(`${r.dir}: ${invalid} malformed items skipped`);
    }
  }

  items.sort((a, b) => b.closed.localeCompare(a.closed));
  return { items, errors };
}

export function readFailures(path: string | undefined): string[] {
  if (path === undefined) return [];
  let st;
  try {
    st = statSync(path);
  } catch {
    return [];
  }
  if (!st.isFile() || st.size > 1048576) return ["failures file unreadable"];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return ["failures file unreadable"];
  }
  const lines = content.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    out.push(trimmed.slice(0, 200));
    if (out.length >= 50) break;
  }
  return out;
}

export function failuresHtml(lines: string[]): string {
  if (lines.length === 0) return "";
  const parts = lines.map((l) => `<div class="feed-fail">${esc(l)}</div>`);
  return `<h2>Failures ${lines.length}</h2>${parts.join("")}`;
}

export function feedHtml(items: Landed[], place?: string): string {
  const placeName = (s: string) => s.replace(/\/+$/, "").split("/").pop() || s;

  // Build counts per place from unfiltered items
  const counts = new Map<string, number>();
  for (const i of items) {
    const p = placeName(i.source);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }

  // Filter links
  const links: string[] = [];
  const allActive = place === undefined;
  links.push(
    `<a href="/feed"${allActive ? ' aria-current="page"' : ""}>all ${items.length}</a>`
  );
  const placeNames = [...counts.keys()].sort();
  for (const p of placeNames) {
    const active = place === p;
    links.push(
      `<a href="/feed?place=${encodeURIComponent(p)}"${active ? ' aria-current="page"' : ""}>${esc(p)} ${counts.get(p)}</a>`
    );
  }

  // Filter items
  const shown = place === undefined ? items : items.filter((i) => placeName(i.source) === place);

  if (shown.length === 0) {
    return `<div class="feed-links">${links.join(" ")}</div><p>Nothing landed in the selected window</p>`;
  }

  // Group by day
  const byDay = new Map<string, Landed[]>();
  for (const i of shown) {
    const day = i.closed.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(i);
  }

  const days = [...byDay.keys()].sort().reverse();
  const groups = days.map((day) => {
    const lines = byDay.get(day)!.map((i) => {
      const time = i.closed.slice(11, 16);
      return `<div class="feed-item"><time>${time}Z</time> <span class="feed-place">${esc(placeName(i.source))}</span> <span class="feed-id">${esc(i.id)}</span> <b>${esc(i.title)}</b>${i.reason ? `<p class="feed-reason">${esc(i.reason)}</p>` : ""}</div>`;
    });
    return `<h2>${day}</h2>${lines.join("")}`;
  });

  return `<div class="feed-links">${links.join(" ")}</div>${groups.join("")}`;
}

export type Decide = {
  q: string;
  context: string;
  options: { id: string; title: string; body: string; rec: boolean }[];
  tail: string;
};

export function parseDecide(
  desc: string
): Decide | { error: string } | null {
  const s = desc.indexOf("<decide>");
  const e = desc.indexOf("</decide>");
  if (s < 0) return null;
  if (e < s) return { error: "no </decide>" };
  const inner = desc.slice(s + 8, e);
  const qs = [...inner.matchAll(/<q>([\s\S]*?)<\/q>/g)];
  if (qs.length !== 1) return { error: `${qs.length} <q>, need exactly 1` };
  const options = [
    ...inner.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g),
  ].map((m) => {
    const at = (k: string) =>
      new RegExp(`\\b${k}="([^"]*)"`).exec(m[1]!)?.[1] ?? "";
    return {
      id: at("id"),
      title: at("title").trim(),
      body: m[2]!.trim(),
      rec: at("rec") === "1",
    };
  });
  if (options.length < 2 || options.length > 5)
    return { error: `${options.length} options, need 2-5` };
  const ids = options.map((o) => o.id);
  if (
    ids.some((id) => !/^[A-E]$/.test(id)) ||
    new Set(ids).size !== ids.length
  )
    return { error: "option ids must be unique A-E" };
  if (options.some((o) => !o.title))
    return { error: "every option needs a title" };
  if (options.filter((o) => o.rec).length > 1)
    return { error: "more than one rec" };
  const context = /<context>([\s\S]*?)<\/context>/.exec(inner)?.[1]?.trim() ?? "";
  return {
    q: qs[0]![1]!.trim(),
    context,
    options,
    tail: (desc.slice(0, s) + desc.slice(e + 9)).trim(),
  };
}

export function sameOrigin(
  h: (k: string) => string | undefined,
  host: string | undefined
): boolean {
  const site = h("sec-fetch-site");
  const origin = h("origin");
  if (site && site !== "same-origin" && site !== "none") return false;
  if (origin && (!host || origin.replace(/^https?:\/\//, "") !== host))
    return false;
  return true;
}

export async function applyDecision(
  input: { dir: string; id: string; action: string; text: string },
  dirs: string[],
  run: Run = bdRun
): Promise<string | null> {
  if (!dirs.includes(input.dir)) return "unknown workspace";
  if (!/^[a-z0-9][a-z0-9_.]*(-[a-z0-9_.]+)+$/i.test(input.id))
    return "bad bead id";
  const parts = input.action.split(":");
  const verb = parts[0] ?? "";
  const option = parts.length > 1 ? parts[1] : undefined;
  if (parts.length > 2 || !["accept", "reject", "defer"].includes(verb))
    return "bad action";
  if (
    option !== undefined &&
    (verb !== "accept" || !/^[A-E]$/.test(option))
  )
    return "bad option";
  const text = input.text.trim().slice(0, 4000);

  const key = `${input.dir}\n${input.id}`;
  if (inFlight.has(key)) return "card is being decided";
  inFlight.add(key);

  try {
    // The verdict is checked against the card as it is now, so a second submit or a changed card
    // cannot write a stray verdict.
    const show = await run(["-C", input.dir, "show", input.id, "--json"]);
    if (show.code !== 0) return "card not found";
    let parsed: unknown;
    try {
      parsed = JSON.parse(show.out);
    } catch {
      return "card not found";
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed[0] === null ||
      typeof parsed[0] !== "object"
    )
      return "card not found";
    const card = parsed[0] as Record<string, unknown>;
    if (
      !Array.isArray(card.labels) ||
      !card.labels.includes("human")
    )
      return "card is no longer waiting";
    // A failed label step can leave both labels on a card; it must not take a second verdict.
    if (card.labels.includes("decided")) return "card is already decided";
    // A closed card must not take a verdict (wb-di1).
    if (typeof card.status === "string" && card.status === "closed")
      return "card is already closed";
    const decide = parseDecide(
      typeof card.description === "string" ? card.description : ""
    );
    const hasOptions = decide !== null && !("error" in decide);
    if (verb === "accept") {
      if (hasOptions) {
        if (option === undefined) return "pick one of the card's options";
        if (!decide.options.some((o) => o.id === option))
          return "not one of this card's options";
      } else if (option !== undefined) {
        return "not one of this card's options";
      }
    }

    const isReply = verb === "defer" && text !== "";
    const isSkip = verb === "defer" && text === "";

    let body: string;
    if (isReply) {
      body = `DECISION reply: ${text}`;
    } else if (isSkip) {
      body = "DECISION skip";
    } else {
      body = `DECISION ${verb}`;
      if (option !== undefined) body += ` ${option}`;
      if (text !== "") body += `: ${text}`;
    }

    // The verdict comment is written first so a card never carries `decided` without its verdict;
    // the labels move in one command so a card never carries both. If the label move fails the
    // card is still waiting and a retry writes the verdict again: the reader only looks at cards
    // labelled `decided` and takes the last verdict comment.
    const steps: string[][] = [];
    if (isSkip) {
      steps.push(["-C", input.dir, "defer", input.id, "--until=now"]);
      steps.push(["-C", input.dir, "comments", "add", "--author", "operator", "--", input.id, body]);
    } else {
      steps.push(["-C", input.dir, "comments", "add", "--author", "operator", "--", input.id, body]);
      steps.push(["-C", input.dir, "update", input.id, "--add-label", "decided", "--remove-label", "human"]);
    }

    for (const step of steps) {
      const result = await run(step);
      if (result.code !== 0)
        return `bd ${step[2]} failed (exit ${result.code})`;
    }
    return null;
  } finally {
    inFlight.delete(key);
  }
}

export function inboxHtml(cards: Card[]): string {
  if (cards.length === 0) return "<p>Nothing waiting on you</p>";
  const parts = cards.map((c) => {
    const decide = parseDecide(c.description ?? "");
    let body = "";
    if (decide && !("error" in decide)) {
      body = `<p>${esc(decide.q)}</p>`;
      if (decide.context) body += `<p>${esc(decide.context)}</p>`;
      if (decide.tail) body += `<pre class="tail">${esc(decide.tail)}</pre>`;
      const optButtons = decide.options.map((o) => {
        const rec = o.rec ? ` <span class="rec">recommended</span>` : "";
        return `<button name="action" value="accept:${o.id}">${esc(o.title)}${rec}<br>${esc(o.body)}</button>`;
      });
      body += `<form method="post" action="/inbox/decide"><input type="hidden" name="dir" value="${esc(c.source)}"><input type="hidden" name="id" value="${esc(c.id)}">${optButtons.join("")}<textarea name="text" maxlength="4000" placeholder="Note (max 4000 chars)"></textarea><button name="action" value="reject">Reject</button><button name="action" value="defer">Reply or skip</button></form>`;
    } else {
      if (decide && "error" in decide) {
        body = `<p class="warn">card format problem: ${esc(decide.error)}</p>`;
      }
      if (c.description) body += `<p>${esc(c.description)}</p>`;
      body += `<form method="post" action="/inbox/decide"><input type="hidden" name="dir" value="${esc(c.source)}"><input type="hidden" name="id" value="${esc(c.id)}"><button name="action" value="accept">Accept</button><textarea name="text" maxlength="4000" placeholder="Note (max 4000 chars)"></textarea><button name="action" value="reject">Reject</button><button name="action" value="defer">Reply or skip</button></form>`;
    }
    const skipTag = c.skipped ? '<span class="tag">skipped</span>' : "";
    return `<article class="card" id="card-${esc(c.id)}" data-card="${esc(c.id)}" tabindex="-1"><h2>${esc(c.id)}</h2><p>${esc(c.title)}${skipTag}</p><time>${esc(
      c.updated
    )}</time>${body}</article>`;
  });
  return parts.join("");
}

export function shell(
  place: string,
  focusHtml: string,
  counts: { inbox: number }
): string {
  const navItems = PLACES.map((p) => {
    const active = p === place;
    const attrs = `href="/${p}"${active ? ' aria-current="page"' : ""}`;
    const label =
      p === "inbox" && counts.inbox > 0
        ? `inbox <b>${counts.inbox}</b>`
        : p;
    return `<a ${attrs}>${label}</a>`;
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Workbench</title>
<style>
:root{--bg:#fff;--fg:#111;--nav-bg:#f5f5f5;--rail:400px;--div:11px;--line:#ccc}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--nav-bg:#1a1a1a;--line:#333}}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow-x:hidden}
body{background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
#places{position:fixed;left:0;top:0;bottom:0;width:140px;background:var(--nav-bg);display:flex;flex-direction:column;padding:1rem;gap:.5rem;z-index:10}
#places a{color:inherit;text-decoration:none;padding:.4rem;border-radius:4px}
#places a[aria-current="page"]{font-weight:700}
#panes{display:grid;grid-template-columns:minmax(0,1fr) var(--div) var(--rail);height:100%;margin-left:140px}
.col{min-width:0;min-height:0;display:flex;flex-direction:column}
#focus{margin:0;padding:1.5rem;overflow-y:auto;min-height:0}
#focus article.card{margin-bottom:1rem;border:1px solid var(--line);border-radius:8px;padding:1rem;background:var(--bg)}
#focus article.card[data-sel]{box-shadow:0 0 0 2px #4a90d9;border-color:#4a90d9}
.divider{position:relative;cursor:col-resize;background:transparent;border:0;padding:0;display:grid;place-items:center;touch-action:none}
.divider::before{content:"";width:1px;height:100%;background:var(--line)}
.divider::after{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:5px;height:46px;border-radius:3px;background:var(--nav-bg);box-shadow:inset 0 0 0 1px var(--line)}
.divider:hover::before,.divider:focus-visible::before,.divider[data-drag]::before{background:#4a90d9;width:2px}
.divider:hover::after,.divider:focus-visible::after,.divider[data-drag]::after{background:#4a90d9}
.divider:focus-visible{outline:none}
body[data-dragging]{cursor:col-resize;user-select:none}
body[data-dragging] .col{pointer-events:none}
#assistant{background:var(--nav-bg);border-left:1px solid var(--line);display:grid;grid-template-rows:auto minmax(0,1fr) auto;min-height:0}
.rail-h{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);font-size:.85rem;min-height:44px}
.rail-h .who{font-weight:600;color:var(--fg)}
.rail-h .ctx{color:var(--fg);opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.rail-h .ctx b{color:#4a90d9;font-weight:600}
.rail-h .x{display:none;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:8px;padding:6px 10px;font-size:.8rem;cursor:pointer;min-height:32px}
.thread{overflow:auto;padding:12px 10px;display:flex;flex-direction:column;gap:9px;min-height:0}
.m{max-width:88%;padding:7px 9px;border-radius:9px;font-size:.85rem;line-height:1.42}
.m.you{align-self:flex-end;background:#17303d;color:#d9eefb}
.m.it{align-self:flex-start;background:var(--bg);color:var(--fg);border:1px solid var(--line)}
.m.cite{align-self:flex-start;background:#101c14;border:1px solid #22452f;color:#a9d9bd;font-size:.75rem;font-family:ui-monospace,monospace}
.comp{border-top:1px solid var(--line);padding:9px 10px;display:grid;gap:7px}
.comp .about{font-size:.75rem;font-family:ui-monospace,monospace;color:var(--fg);opacity:.7;display:flex;gap:6px;align-items:center}
.comp .about b{color:#4a90d9;font-weight:400}
.comp textarea{width:100%;min-height:56px;max-height:180px;resize:vertical;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:9px;padding:8px 9px;font:13px system-ui}
.comp .row{display:flex;gap:7px}
.comp .row button{flex:1;padding:8px 12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:8px;cursor:pointer;min-height:36px;font-size:.8rem}
.comp .row button:hover{border-color:#4a90d9;color:#4a90d9}
.comp .row button.pri{background:#12303f;border-color:#4a90d9;color:#d9eefb}
.comp .row button.pri:hover{background:#1a4050}
.feed-links{margin-bottom:1rem;line-height:1.6}
.feed-links a{color:inherit;margin-right:.5rem;white-space:nowrap}
.feed-links a[aria-current="page"]{font-weight:700}
.feed-links~h2{font-size:1rem;margin:1.25rem 0 .25rem}
.feed-item{padding:.5rem 0;border-top:1px solid var(--nav-bg);overflow-wrap:anywhere}
.feed-item time,.feed-place,.feed-id,.feed-reason{opacity:.7;font-size:.85em}
.feed-item b{display:block;font-weight:600}
.feed-fail{padding:.35rem 0;color:#b3261e;overflow-wrap:anywhere}
@media(max-width:899px){
  #places{position:fixed;bottom:0;left:0;right:0;top:auto;width:100%;flex-direction:row;justify-content:space-around;padding:.5rem}
  #panes{margin-left:0;grid-template-columns:minmax(0,1fr)}
  .divider{display:none}
  #assistant{display:none;border-left:0}
  #focus{margin:0;padding:1rem 1rem 4rem}
  #panes[data-mode="focus"] #focus{display:none}
  #panes[data-mode="focus"] #assistant{display:grid;position:fixed;top:0;left:0;right:0;bottom:0;z-index:20}
  #panes[data-mode="focus"] .rail-h .x{display:inline-block}
}
@media(min-width:900px){.rail-h .x{display:none}}
</style>
</head>
<body>
<nav id="places">${navItems.join("")}</nav>
<main id="panes" data-mode="split">
<section class="col cards" id="cardsCol"><main id="focus">${focusHtml}</main></section>
<div class="divider" id="divider" role="separator" aria-orientation="vertical" aria-label="resize: cards / assistant" tabindex="0"></div>
<aside class="col rail" id="assistant">
<div class="rail-h">
<button class="x" id="back">← cards</button>
<span class="who">assistant</span>
<span class="ctx">about <b id="ctx">—</b></span>
</div>
<div class="thread" id="thread">
<div class="m it">Discuss the card in view. Your reply posts to the card.</div>
</div>
<div class="comp">
<div class="about">about <b id="ctx2">—</b> · this goes on the card as a reply</div>
<textarea id="compText" placeholder="say what's wrong, or what you want instead"></textarea>
<div class="row">
<button class="pri" id="sendBtn">send as reply</button>
</div>
</div>
</aside>
</main>
<script>
(function(){
var panes=document.getElementById("panes"),root=document.documentElement;
var divider=document.getElementById("divider");
var rail=document.getElementById("assistant");
var KEY="controlpane.railFrac";
var MIN_RAIL=300,MIN_CARDS=300;
var isNarrow=function(){return matchMedia("(max-width:899px)").matches};
function bounds(){var total=panes.clientWidth;var max=Math.max(MIN_RAIL,total-MIN_CARDS-divider.offsetWidth);return{total:total,min:MIN_RAIL,max:max}}
function setRail(px,persist){var b=bounds();var w=Math.round(Math.min(b.max,Math.max(b.min,px)));root.style.setProperty("--rail",w+"px");if(persist&&b.total>0){try{localStorage.setItem(KEY,String(w/b.total))}catch(e){}}}
function restore(){var frac=0.28;try{frac=parseFloat(localStorage.getItem(KEY))||frac}catch(e){}if(frac<0.12||frac>0.75)frac=0.28;setRail(panes.clientWidth*frac,false)}
var startX=0,startRail=0;
divider.addEventListener("pointerdown",function(e){if(isNarrow())return;divider.setPointerCapture(e.pointerId);divider.dataset.drag="1";document.body.dataset.dragging="1";startX=e.clientX;startRail=rail.clientWidth});
divider.addEventListener("pointermove",function(e){if(!divider.dataset.drag)return;setRail(startRail+(startX-e.clientX))});
var endDrag=function(){if(!divider.dataset.drag)return;delete divider.dataset.drag;delete document.body.dataset.dragging;setRail(rail.clientWidth,true)};
divider.addEventListener("pointerup",endDrag);
divider.addEventListener("pointercancel",endDrag);
divider.addEventListener("dblclick",function(){setRail(panes.clientWidth*0.28,true)});
divider.addEventListener("keydown",function(e){var step=e.shiftKey?64:16;if(e.key==="ArrowLeft"){setRail(rail.clientWidth+step,true);e.preventDefault()}if(e.key==="ArrowRight"){setRail(rail.clientWidth-step,true);e.preventDefault()}});
function selectCard(id){document.querySelectorAll(".card").forEach(function(c){c.removeAttribute("data-sel")});document.getElementById("ctx").textContent=id;document.getElementById("ctx2").textContent=id;var card=document.getElementById("card-"+id);if(card){card.setAttribute("data-sel","1");if(!isNarrow())card.scrollIntoView({block:"nearest"})}return card}
document.querySelectorAll(".card").forEach(function(card){card.addEventListener("click",function(){selectCard(card.dataset.card)})});
document.getElementById("sendBtn").addEventListener("click",function(){var id=document.getElementById("ctx").textContent;var text=document.getElementById("compText").value.trim();if(!id||id==="—"||!text)return;var card=document.getElementById("card-"+id);if(!card)return;var form=card.querySelector("form");if(!form)return;var ta=form.querySelector("textarea");if(ta){ta.value=text};form.submit()});
document.getElementById("back").addEventListener("click",function(){panes.dataset.mode="split";var sel=document.querySelector(".card[data-sel]");if(sel)sel.focus({preventScroll:true})});
addEventListener("resize",function(){if(!isNarrow())setRail(rail.clientWidth||panes.clientWidth*0.28,false)});
addEventListener("keydown",function(e){if(e.key==="Escape"&&panes.dataset.mode==="focus")document.getElementById("back").click()});
restore();setRail(rail.clientWidth||panes.clientWidth*0.28,false);
})();
</script>
</body>
</html>`;
}

export async function handle(
  req: Request,
  deps: { beadDirs: string[]; run?: Run; hosts?: string[]; failuresFile?: string }
): Promise<Response> {
  const res = await route(req, deps);
  // The pane has no login, so another site must not be able to show it in a frame and trick a click
  // onto a verdict button.
  res.headers.set("x-frame-options", "DENY");
  res.headers.set("content-security-policy", "frame-ancestors 'none'");
  return res;
}

async function route(
  req: Request,
  deps: { beadDirs: string[]; run?: Run; hosts?: string[]; failuresFile?: string }
): Promise<Response> {
  // The pane has no login. Another site can point its own name at the pane's address and then looks
  // same-origin to the browser; answering only to the pane's own names shuts that out.
  if (deps.hosts && deps.hosts.length > 0) {
    const h = req.headers.get("host")?.toLowerCase();
    if (!h || !deps.hosts.includes(h)) {
      return new Response("wrong host", { status: 421 });
    }
  }

  const path = new URL(req.url).pathname;

  if (path === "/") {
    return new Response(null, {
      status: 302,
      headers: { location: "/inbox" },
    });
  }

  if (path === "/healthz") {
    return new Response("ok");
  }

  if (path === "/inbox/decide") {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    if (
      !sameOrigin(
        (k) => req.headers.get(k) ?? undefined,
        req.headers.get("host") ?? undefined
      )
    ) {
      return new Response("forbidden", { status: 403 });
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return new Response("bad form", { status: 400 });
    }
    const field = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : "";
    };
    let err: string | null;
    try {
      err = await applyDecision(
        { dir: field("dir"), id: field("id"), action: field("action"), text: field("text") },
        deps.beadDirs,
        deps.run
      );
    } catch {
      return new Response("could not write the verdict; check the card before trying again", { status: 500 });
    }
    if (err) {
      return new Response(err, { status: 400 });
    }
    return new Response(null, {
      status: 303,
      headers: { location: "/inbox" },
    });
  }

  if (path === "/inbox") {
    const { cards, errors } = await loadCards(deps.beadDirs, deps.run);
    const errorsHtml =
      errors.length > 0
        ? "<ul>" + errors.map((e) => `<li>${esc(e)}</li>`).join("") + "</ul>"
        : "";
    const html = shell("inbox", inboxHtml(cards) + errorsHtml, {
      inbox: cards.length,
    });
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (path === "/feed") {
    const [cards, landed] = await Promise.all([
      loadCards(deps.beadDirs, deps.run),
      loadLanded(deps.beadDirs, deps.run),
    ]);
    const url = new URL(req.url);
    let place = url.searchParams.get("place");
    if (place === "" || place === null) place = undefined; // wb-j23: empty/missing place means all
    const errorsHtml = landed.errors
      .map((e) => `<p class="warn">${esc(e)}</p>`)
      .join("");
    const failures = failuresHtml(readFailures(deps.failuresFile));
    const html = shell("feed", failures + feedHtml(landed.items, place) + errorsHtml, {
      inbox: cards.cards.length,
    });
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (PLACES.includes(path.slice(1) as typeof PLACES[number])) {
    const { cards } = await loadCards(deps.beadDirs, deps.run);
    const html = shell(path.slice(1), "<p>not built yet</p>", {
      inbox: cards.length,
    });
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response("not found", { status: 404 });
}