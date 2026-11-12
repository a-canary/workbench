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
  description?: string;
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
  const set = new Set<string>();
  set.add(`${host}:${port}`);
  set.add(`localhost:${port}`);
  set.add(`127.0.0.1:${port}`);
  const out: string[] = [];
  const ordered = [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`];
  for (const h of ordered) {
    if (set.has(h)) {
      out.push(h);
      set.delete(h);
    }
  }
  return out;
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
  run: Run = bdRun
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
      if (item.status !== "open" && item.status !== "in_progress") continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      cards.push({
        id: item.id,
        title: item.title,
        priority: item.priority,
        updated: item.updated_at,
        source: r.dir,
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
  if (parts.length > 2 || !["accept", "reject", "defer", "comment"].includes(verb))
    return "bad action";
  if (
    option !== undefined &&
    (verb !== "accept" || !/^[A-E]$/.test(option))
  )
    return "bad option";
  const text = input.text.trim().slice(0, 4000);
  if (verb === "comment" && text === "") return "comment is empty";

  const isReply = verb === "defer" && text !== "";
  const isSkip = verb === "defer" && text === "";
  const decides = verb === "accept" || verb === "reject" || isReply;

  let body: string;
  if (verb === "comment") {
    body = text;
  } else if (isReply) {
    body = `DECISION reply: ${text}`;
  } else if (isSkip) {
    body = "DECISION skip";
  } else {
    body = `DECISION ${verb}`;
    if (option !== undefined) body += ` ${option}`;
    if (text !== "") body += `: ${text}`;
  }

  const steps: string[][] = [];
  if (decides)
    steps.push(["-C", input.dir, "label", "add", input.id, "decided"]);
  if (isSkip) steps.push(["-C", input.dir, "defer", input.id, "--until=now"]);
  steps.push([
    "-C",
    input.dir,
    "comments",
    "add",
    "--author",
    "operator",
    "--",
    input.id,
    body,
  ]);
  if (decides)
    steps.push(["-C", input.dir, "label", "remove", input.id, "human"]);

  for (const step of steps) {
    const result = await run(step);
    if (result.code !== 0)
      return `bd ${step[2]} failed (exit ${result.code})`;
  }
  return null;
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
      const optButtons = decide.options.map((o) => {
        const rec = o.rec ? ` <span class="rec">recommended</span>` : "";
        return `<button name="action" value="accept:${o.id}">${esc(o.title)}${rec}<br>${esc(o.body)}</button>`;
      });
      body += `<form method="post" action="/inbox/decide"><input type="hidden" name="dir" value="${esc(c.source)}"><input type="hidden" name="id" value="${esc(c.id)}">${optButtons.join("")}<textarea name="text"></textarea><button name="action" value="reject">Reject</button><button name="action" value="defer">Reply or skip</button></form>`;
    } else {
      if (c.description) body = `<p>${esc(c.description)}</p>`;
      body += `<form method="post" action="/inbox/decide"><input type="hidden" name="dir" value="${esc(c.source)}"><input type="hidden" name="id" value="${esc(c.id)}"><button name="action" value="accept">Accept</button><textarea name="text"></textarea><button name="action" value="reject">Reject</button><button name="action" value="defer">Reply or skip</button></form>`;
    }
    return `<article><h2>${esc(c.id)}</h2><p>${esc(c.title)}</p><time>${esc(
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
  deps: { beadDirs: string[]; run?: Run; hosts?: string[] }
): Promise<Response> {
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
    const form = await req.formData();
    const field = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : "";
    };
    const err = await applyDecision(
      { dir: field("dir"), id: field("id"), action: field("action"), text: field("text") },
      deps.beadDirs,
      deps.run
    );
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
