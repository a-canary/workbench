// Standalone driver dashboard server: GET /driver/ renders driverPanel + steer controls,
// POST /driver/steer applies one form via applySteer and writes steer-<lane>.json.
// Env: PORT (default 8097), HOST (default 127.0.0.1), DRIVER_LANE (default "claude"),
//      SPRINT_LOG (default "sprints.jsonl"), SPRINT_STEER (default "steer-<lane>.json"),
//      QUEUE_CMD (default "bun <dir>/../queue/cli.ts 6").
// ponytail: no auth/CSRF — bind 127.0.0.1 (or a tailnet address); add a token before exposing wider.

import { sprints, type End, type Sprint, type Start } from "../sprint/log.ts";
import { readSteer, saveSteer } from "../sprint/steer.ts";
import { driverPanel, type Ctx, type Rel } from "./driver.ts";
import { esc } from "./fmt.ts";
import { applySteer } from "./steer-apply.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Run = (cmd: string[]) => Promise<string>;

export type Srv = {
  lane: string;
  log: string;
  steer: string;
  run: Run;
  queueCmd: string[];
  now?: () => number;
};

function parseJsonArray(text: string): unknown[] {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function toRel(v: unknown): Rel | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : undefined;
  if (!id) return undefined;
  return {
    id,
    title: typeof o.title === "string" ? o.title : id,
    status: typeof o.status === "string" ? o.status : undefined,
  };
}

export async function loadCtx(cur: Sprint | undefined, run: Run, queueCmd: string[]): Promise<Ctx> {
  // Queue is always fetched.
  const queueOut = await run(queueCmd);
  const queue: Rel[] = [];
  for (const line of queueOut.split("\n")) {
    const parts = line.trim().split("\t");
    if (parts.length >= 4) {
      queue.push({ id: parts[1], title: parts[3] });
    }
  }

  if (!cur) {
    return { deps: [], dependents: [], comments: [], missions: [], queue };
  }

  // Fetch deps, dependents, and comments in parallel.
  const [showOut, depOut, commOut] = await Promise.all([
    run(["bd", "-C", cur.dir, "show", cur.id, "--json"]),
    run(["bd", "-C", cur.dir, "dep", "list", cur.id, "--direction=up", "--json"]),
    run(["bd", "-C", cur.dir, "comments", cur.id, "--json"]),
  ]);

  // deps = parsed[0].dependencies from bd show --json
  let deps: Rel[] = [];
  try {
    const showArr = parseJsonArray(showOut);
    if (showArr.length > 0) {
      const first = showArr[0] as Record<string, unknown>;
      if (Array.isArray(first.dependencies)) {
        deps = first.dependencies.map(toRel).filter((r): r is Rel => r !== undefined);
      }
    }
  } catch {
    deps = [];
  }

  // dependents = parsed array from bd dep list --direction=up --json
  const dependents: Rel[] = parseJsonArray(depOut)
    .map(toRel)
    .filter((r): r is Rel => r !== undefined);

  // comments = last 3, as {ts: created_at, author, text}
  const comments: { ts: string; author: string; text: string }[] = parseJsonArray(commOut)
    .slice(-3)
    .map((c: unknown) => {
      const o = c as Record<string, unknown>;
      return {
        ts: typeof o.created_at === "string" ? o.created_at : "",
        author: typeof o.author === "string" ? o.author : "",
        text: typeof o.text === "string" ? o.text : "",
      };
    });

  return { deps, dependents, comments, missions: [], queue };
}

export function readLog(path: string): (Start | End)[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const evs: (Start | End)[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (e && typeof e === "object" && !Array.isArray(e)) evs.push(e);
    } catch {
      // skip unparseable
    }
  }
  return evs;
}

export async function handle(req: Request, s: Srv): Promise<Response> {
  const now = s.now?.() ?? Date.now();
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/driver/") {
    const all = sprints(readLog(s.log), s.lane, now);
    const cur = all.find((sp) => sp.end === undefined);
    const ctx = await loadCtx(cur, s.run, s.queueCmd);
    const flash = url.searchParams.get("flash");
    const body = driverPanel(s.lane, all, ctx, readSteer(s.steer), { flash: flash ?? undefined, now });

    const steerForms = `
    <div class="dr-section"><h3>Steer</h3>
      <form method="post" action="/driver/steer">
        <input type="hidden" name="action" value="pin">
        <input type="text" name="id" placeholder="pin bead id">
        <button type="submit">Pin</button>
      </form>
      <form method="post" action="/driver/steer">
        <input type="hidden" name="action" value="skip">
        <input type="text" name="id" placeholder="skip bead id">
        <button type="submit">Skip</button>
      </form>
      <form method="post" action="/driver/steer">
        <input type="hidden" name="action" value="note">
        <input type="text" name="text" placeholder="steering note">
        <button type="submit">Note</button>
      </form>
    </div>`;

    return new Response(
      `<!doctype html><meta charset="utf-8"><title>driver ${esc(s.lane)}</title>${body}${steerForms}`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  if (req.method === "POST" && url.pathname === "/driver/steer") {
    // A browser sends Origin on a cross-site form post: refuse it, so another page can't plant notes the Driver reads.
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) return new Response("cross-origin post refused", { status: 403 });
    let fd: FormData;
    try {
      fd = await req.formData();
    } catch {
      return new Response("expected a form body", { status: 400 });
    }
    const f = {
      action: fd.get("action") ?? "",
      id: typeof fd.get("id") === "string" ? fd.get("id") : undefined,
      text: typeof fd.get("text") === "string" ? fd.get("text") : undefined,
    };
    const next = applySteer(readSteer(s.steer), f, new Date(now));
    let error: string | undefined;
    if (typeof next === "string") {
      error = next;
    } else {
      saveSteer(s.steer, next);
    }
    return new Response(null, {
      status: 303,
      headers: { location: `/driver/?flash=${encodeURIComponent(error ?? "ok")}` },
    });
  }

  return new Response("not found", { status: 404 });
}

/** Real Run: stdout of a zero exit, else "" (spawn error, non-zero exit, or the 30s timeout). */
export const spawnRun: Run = async (cmd) => {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", timeout: 30_000 });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out : "";
  } catch {
    return "";
  }
};

if (import.meta.main) {
  const lane = process.env.DRIVER_LANE ?? "claude";
  const log = process.env.SPRINT_LOG ?? "sprints.jsonl";
  const steer = process.env.SPRINT_STEER ?? `steer-${lane}.json`;
  const queueCmd = process.env.QUEUE_CMD
    ? process.env.QUEUE_CMD.split(" ")
    : ["bun", join(import.meta.dir, "../queue/cli.ts"), "6"];

  const s: Srv = { lane, log, steer, run: spawnRun, queueCmd };

  const port = Number(process.env.PORT ?? 8097);
  const host = process.env.HOST ?? "127.0.0.1";
  // idleTimeout: a GET waits on the queue command + 3 bd calls (~20s on a busy estate); bun defaults to 10s.
  Bun.serve({ port, hostname: host, idleTimeout: 60, fetch: (r) => handle(r, s) });
  console.log(`driver dashboard listening on http://${host}:${port}/driver/`);
}
