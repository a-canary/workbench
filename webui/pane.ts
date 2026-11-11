import { readFileSync } from "node:fs";
// Control pane shell (slice B1). Public framework: no repo, seat or
// mission names in code; personal paths come from <config dir>/pane.json.

export const PLACES = ["inbox", "feed", "seats", "work", "vision"] as const;

export type Run = (args: string[]) => Promise<{ code: number; out: string }>;

export type Card = {
  id: string;
  title: string;
  priority: number;
  updated: string;
  source: string;
  legacy?: boolean;
};

export const bdRun: Run = async (args) => {
  const proc = Bun.spawn(["bd", ...args], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
};

export function loadConfig(dir: string): { beadDirs: string[] } {
  const path = `${dir}/pane.json`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`missing config: ${path}`);
  }
  const cfg = JSON.parse(raw);
  if (!Array.isArray(cfg.beadDirs)) {
    throw new Error(`bad pane.json: missing beadDirs array`);
  }
  return cfg;
}

export async function loadCards(
  dirs: string[],
  run: Run = bdRun
): Promise<{ cards: Card[]; errors: string[] }> {
  const errors: string[] = [];
  const seen = new Set<string>();
  const cards: Card[] = [];

  for (const dir of dirs) {
    const result = await run(["-C", dir, "human", "list", "--json"]);
    if (result.code !== 0) {
      errors.push(`${dir}: bd exited ${result.code}`);
      continue;
    }
    let items: unknown[];
    try {
      items = JSON.parse(result.out);
      if (!Array.isArray(items)) throw new Error("not an array");
    } catch {
      errors.push(`${dir}: bad JSON from bd`);
      continue;
    }
    for (const item of items as Record<string, unknown>[]) {
      if (item.status !== "open" && item.status !== "in_progress") continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      cards.push({
        id: item.id,
        title: item.title,
        priority: item.priority,
        updated: item.updated_at,
        source: dir,
      });
    }
  }

  cards.sort((a, b) => {
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

export function inboxHtml(cards: Card[]): string {
  if (cards.length === 0) return "<p>Nothing waiting on you</p>";
  const parts = cards.map((c) => {
    const badge = c.legacy
      ? `<span class="legacy">legacy · ${esc(c.source)} · ${esc(c.updated)}</span>`
      : "";
    return `<article><h2>${esc(c.id)}</h2><p>${esc(c.title)}</p><time>${esc(
      c.updated
    )}</time>${badge}</article>`;
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
#places{position:fixed;left:0;top:0;bottom:0;width:140px;background:var(--nav-bg);display:flex;flex-direction:column;padding:1rem;gap:.5rem}
#places a{color:inherit;text-decoration:none;padding:.4rem;border-radius:4px}
#places a[aria-current="page"]{font-weight:700}
#focus{margin-left:140px;margin-right:300px;padding:1.5rem;min-height:100vh}
#assistant{position:fixed;right:0;top:0;bottom:0;width:300px;background:var(--nav-bg);padding:1.5rem;overflow:auto}
#assistant h2{font-size:1rem;margin-bottom:.75rem}
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
  deps: { beadDirs: string[]; run?: Run }
): Promise<Response> {
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

  if (PLACES.includes(path.slice(1) as typeof PLACES[number])) {
    const html = shell(path.slice(1), "<p>not built yet</p>", { inbox: 0 });
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response("not found", { status: 404 });
}
