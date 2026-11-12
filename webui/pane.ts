import { readFileSync } from "node:fs";
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
  legacy?: boolean;
  description?: string;
  skipped?: true;
};

export const bdRun: Run = async (args) => {
  const proc = Bun.spawn(["bd", ...args], { stdout: "pipe", timeout: 15000 });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
};

export function loadConfig(dir: string): { beadDirs: string[]; hosts?: string[] } {
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
  const obj = cfg as { beadDirs: string[]; hosts?: unknown };
  if (obj.hosts !== undefined) {
    if (!Array.isArray(obj.hosts) || obj.hosts.some((h) => typeof h !== "string")) {
      throw new Error(`bad pane.json: ${path}: hosts must be an array of strings`);
    }
    return { beadDirs: obj.beadDirs, hosts: obj.hosts };
  }
  return { beadDirs: obj.beadDirs };
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
        typeof (raw as Record<string, unknown>).closed_at !== "string"
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

export function feedHtml(items: Landed[], place?: string): string {
  const placeName = (s: string) => s.split("/").pop() ?? s;

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
    return `<div class="feed-links">${links.join(" ")}</div><p>Nothing landed in the last few days</p>`;
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
      return `<div class="feed-item"><time>${time}</time> <span class="feed-place">${esc(placeName(i.source))}</span> <span class="feed-id">${esc(i.id)}</span> ${esc(i.title)}${i.reason ? ` — ${esc(i.reason)}` : ""}</div>`;
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
    const badge = c.legacy
      ? `<span class="legacy">legacy · ${esc(c.source)} · ${esc(c.updated)}</span>`
      : "";
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
      body += `<form method="post" action="/inbox/decide"><input type="hidden" name="dir" value="${esc(c.source)}"><input type="hidden" name="id" value="${esc(c.id)}">${optButtons.join("")}<textarea name="text"></textarea><button name="action" value="reject">Reject</button><button name="action" value="defer">Reply or skip</button></form>`;
    } else {
      if (decide && "error" in decide) {
        body = `<p class="warn">card format problem: ${esc(decide.error)}</p>`;
      }
      if (c.description) body += `<p>${esc(c.description)}</p>`;
      body += `<form method="post" action="/inbox/decide"><input type="hidden" name="dir" value="${esc(c.source)}"><input type="hidden" name="id" value="${esc(c.id)}"><button name="action" value="accept">Accept</button><textarea name="text"></textarea><button name="action" value="reject">Reject</button><button name="action" value="defer">Reply or skip</button></form>`;
    }
    const skipTag = c.skipped ? '<span class="tag">skipped</span>' : "";
    return `<article><h2>${esc(c.id)}</h2><p>${esc(c.title)}${skipTag}</p><time>${esc(
      c.updated
    )}</time>${badge}${body}</article>`;
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
:root{--bg:#fff;--fg:#111;--nav-bg:#f5f5f5}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--nav-bg:#1a1a1a}}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow-x:hidden}
body{background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
#places{position:fixed;left:0;top:0;bottom:0;width:140px;background:var(--nav-bg);display:flex;flex-direction:column;padding:1rem;gap:.5rem}
#places a{color:inherit;text-decoration:none;padding:.4rem;border-radius:4px}
#places a[aria-current="page"]{font-weight:700}
#focus{margin-left:140px;margin-right:300px;padding:1.5rem;min-height:100vh}
#assistant{position:fixed;right:0;top:0;bottom:0;width:300px;background:var(--nav-bg);padding:1.5rem;overflow:auto}
#assistant h2{font-size:1rem;margin-bottom:.75rem}
.feed-links{margin-bottom:1rem;line-height:1.6}
@media(max-width:700px){
  #places{position:fixed;bottom:0;left:0;right:0;top:auto;width:100%;flex-direction:row;justify-content:space-around;padding:.5rem}
  #focus{margin:0;padding:1rem 1rem 4rem}
  #assistant{display:none}
}
</style>
</head>
<body>
<nav id="places">${navItems.join("")}</nav>
<main id="focus">${focusHtml}</main>
<aside id="assistant"><h2>Assistant</h2><p>not built yet</p></aside>
</body>
</html>`;
}

export async function handle(
  req: Request,
  deps: { beadDirs: string[]; run?: Run; hosts?: string[] }
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
  deps: { beadDirs: string[]; run?: Run; hosts?: string[] }
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
    const place = url.searchParams.get("place") ?? undefined;
    const errorsHtml = landed.errors
      .map((e) => `<p class="warn">${esc(e)}</p>`)
      .join("");
    const html = shell("feed", feedHtml(landed.items, place) + errorsHtml, {
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
