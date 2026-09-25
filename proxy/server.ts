// arc-llm-proxy — switchboard front for multiple LLM endpoints.
//
//   CONFIG_FILE → JSON switchboard config:
//     endpoints:  name → {url, model, uxOnly?}
//     aliases:    name → ordered endpoint ladder (first healthy with a free
//                 slot wins; the rest are failover)
//     projects:   name → {speed 0-10, mask: [alias...]}
//     maxTokens:  {ux?, "non-ux"?} — per-class generation cap, enforced here
//     defaultProject / strict: bare <alias> model names resolve to the
//                 default project unless strict mode rejects them
//   KEYS_FILE → {"<key>": "<user>" | {"user","class":"ux"|"non-ux"}}.
//                 String values default to class "ux".
//
//   Model path: <project>/<alias>. Everything queues. Dispatch happens on
//   request arrival, on every probe tick, and on request completion:
//     - the UX queue drains before the non-UX queue
//     - within a queue: max(wait_ms * project.speed), tie → FIFO
//     - speed 0 dispatches only while no speed>=1 request is waiting
//   429/5xx from an endpoint trips its breaker (BREAKER_MS); a failed
//   connect marks it down and requeues the request for its next candidate.
//   /health is open; everything else needs a key.

import http from "node:http";
import https from "node:https";
import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { autoLlm } from "./auto-llm.ts";
import { autoVec } from "./auto-vec.ts";
import { localLlm } from "./local-llm.ts";
import { SseToolCallFixer } from "./sse-fix.ts";

// phase-1 shadow: auto-vec observes served turns and logs what it would pick;
// it never routes, and observe() is fire-and-forget (off the request path).
// Deferred: auto-llm.ts value-imports from server.ts (affinityKeyFromBody), so
// this module sits in a cycle — read autoVec only after the graph initializes.
setImmediate(() => {
  if (autoVec.enabled) autoLlm.observe = (e, t) => autoVec.observe(e as never, t);
  if (autoVec.cfgLive) autoLlm.route = (t, ok) => autoVec.route(t, ok) as never;
});

const PORT = Number(process.env.PORT ?? 8091);
const HOST = process.env.HOST ?? "0.0.0.0";
const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const BREAKER_MS = Number(process.env.BREAKER_MS ?? 300_000);
const DEFAULT_CAP = 16_384;
// Shallow audit log (JSONL, append-only). One metadata line per dispatched
// request — rates/balances come from a group-by on this file. Deep mode adds
// the prompt body for the next N requests when armed via POST /__audit.
const LOG_FILE = process.env.LOG_FILE ?? "deploy/audit.jsonl";
const DEEP_CAP = 8_000; // max prompt chars kept in a deep log line (bounds size)

export type KeyClass = "ux" | "non-ux";
export type Lane = "private" | "public";

export interface KeyInfo {
  user: string;
  cls: KeyClass;
  /** Silo binding: which lane this key may call. Fail-closed when unset and LANE is enforced. */
  lane?: Lane;
  /** Bearer not in our key file — identity is ext-<hash8>; upstream validates the key. */
  external?: boolean;
}

export interface EndpointDef {
  url: string;
  model: string;
  uxOnly?: boolean;
  /** File with the upstream Bearer token (relative to the working dir). Never commit the key itself. */
  authFile?: string;
  /** Populated at boot from authFile — a missing key file crashes startup (loud). */
  authToken?: string;
  /** "slots" (llama-server /slots, default) or "models" (OpenAI-compat /models). */
  probe?: "slots" | "models";
  /** Concurrency for "models" probes (default 2). */
  slots?: number;
  /** Path prefix prepended to the client path — upstreams serving OpenAI under a subpath (OpenRouter: /api). */
  prefix?: string;
  /** Client's own Authorization flows through untouched (upstream authenticates it).
   *  authToken/authFile stays probe-only. External (non-keyfile) identities may
   *  only route to passthrough endpoints. */
  authPassthrough?: boolean;
  /** Local GGUF engine managed by local-llm.ts: spawned on demand, so a failed
   *  probe means "not loaded", not "broken". */
  local?: boolean;
}
export interface ProjectDef {
  speed: number;
  mask: string[];
}
export interface SwitchboardCfg {
  endpoints: Record<string, EndpointDef>;
  aliases: Record<string, string[]>;
  projects: Record<string, ProjectDef>;
  maxTokens?: Partial<Record<KeyClass, number>>;
  defaultProject?: string;
  strict?: boolean;
}

export type ModelParse =
  | { project: string; alias: string; candidates: string[]; upstreamModel?: string }
  | { error: string };

/**
 * Pure model-path resolver + policy gate — no sockets, unit-testable.
 * Returns the class-filtered endpoint ladder (uxOnly endpoints dropped for
 * non-ux keys) or a descriptive 400 error.
 */
export function parseModel(
  model: string,
  cfg: SwitchboardCfg,
  cls: KeyClass,
  external = false,
): ModelParse {
  let project: string;
  let alias: string;
  const slash = model.indexOf("/");
  if (slash >= 0) {
    project = model.slice(0, slash);
    alias = model.slice(slash + 1);
  } else if (cfg.strict) {
    return { error: `model must be <project>/<alias> (got "${model}"); strict mode is on` };
  } else if (cfg.aliases[model]) {
    project = cfg.defaultProject ?? Object.keys(cfg.projects)[0];
    alias = model;
  } else {
    return { error: `unknown alias "${model}" (known: ${Object.keys(cfg.aliases).join(", ")})` };
  }
  const p = cfg.projects[project];
  if (!p)
    return { error: `unknown project "${project}" (known: ${Object.keys(cfg.projects).join(", ")})` };
  // passthrough combo addressing: "<base>/<upstreamModel>" resolves when every
  // endpoint under <base> is authPassthrough (e.g. pool/Driver → 9router combo).
  let upstreamModel: string | undefined;
  if (!cfg.aliases[alias]) {
    const s2 = alias.indexOf("/");
    const base = s2 >= 0 ? alias.slice(0, s2) : "";
    const rest = s2 >= 0 ? alias.slice(s2 + 1) : "";
    if (rest && cfg.aliases[base]?.every((n) => cfg.endpoints[n]?.authPassthrough)) {
      alias = base;
      upstreamModel = rest;
    }
  }
  if (!cfg.aliases[alias])
    return { error: `unknown alias "${alias}" (known: ${Object.keys(cfg.aliases).join(", ")})` };
  if (!p.mask.includes(alias))
    return { error: `project "${project}" may not use alias "${alias}" (mask: ${p.mask.join(", ")})` };
  const candidates = cfg.aliases[alias].filter(
    (n) =>
      (cls === "ux" || !cfg.endpoints[n]?.uxOnly) &&
      (!external || !!cfg.endpoints[n]?.authPassthrough),
  );
  if (candidates.length === 0)
    return {
      error: external
        ? `external keys may only use passthrough endpoints — alias "${alias}" has none`
        : `non-ux key may not use alias "${alias}" (all its endpoints are ux-only)`,
    };
  return upstreamModel ? { project, alias, candidates, upstreamModel } : { project, alias, candidates };
}

type AuthHeaders = {
  authorization?: string | string[];
  "x-api-key"?: string | string[];
  "x-user"?: string | string[];
};

/**
 * Pure auth/identity resolver — no sockets, unit-testable.
 * keys=null → open mode: X-User header (class ux), fallback "default".
 * keys set  → Bearer/x-api-key token must map to a key; null = reject.
 */
export function authUser(
  headers: AuthHeaders,
  keys: Map<string, KeyInfo> | null,
): KeyInfo | null {
  const single = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  if (!keys) return { user: single(headers["x-user"]) || "default", cls: "ux" };
  const raw = single(headers.authorization) ?? single(headers["x-api-key"]);
  const tok = raw ? raw.replace(/^Bearer\s*/i, "") : "";
  return tok ? (keys.get(tok) ?? null) : null;
}

/**
 * Pure body rewriter — sets the upstream model name and clamps the
 * generation cap per class. Non-JSON bodies pass through untouched.
 */
export function rewriteBody(body: Buffer, model: string, cap: number): Buffer {
  let j: Record<string, unknown>;
  try {
    const p = JSON.parse(body.toString("utf8"));
    if (typeof p !== "object" || p === null) return body;
    j = p;
  } catch {
    return body;
  }
  j.model = model;
  for (const k of ["max_tokens", "max_completion_tokens"])
    if (typeof j[k] === "number" && (j[k] as number) > cap) j[k] = cap;
  // ponytail: "developer" is OpenAI's newer spelling of "system"; tokenrouter
  // rejects it (400) while every endpoint here accepts "system". Normalize for
  // all endpoints — no per-endpoint flag until one actually needs "developer".
  if (Array.isArray(j.messages))
    for (const m of j.messages as Record<string, unknown>[])
      if (m && m.role === "developer") m.role = "system";
  return Buffer.from(JSON.stringify(j));
}

export interface AuditInput {
  id: number;
  user: string;
  cls: KeyClass;
  project: string;
  alias: string;
  ep: string;
  model: string;
  path: string;
  status: number;
  enqueuedAt: number;
  dispatchedAt: number;
  body: Buffer;
  now: number;
  deep: boolean;
}

/**
 * Pure audit-record builder — no sockets, unit-testable. Shallow always logs
 * metadata (identity + timing + size); deep adds the prompt body (capped) so a
 * human can judge whether the request fits its alias/class guidelines.
 */
export function buildAuditRecord(i: AuditInput): Record<string, unknown> {
  let n_msgs = 0;
  let prompt_chars = 0;
  let max_tokens: number | undefined;
  let messagesRaw: string | null = null;
  try {
    const j = JSON.parse(i.body.toString("utf8")) as Record<string, unknown>;
    if (Array.isArray(j.messages)) {
      n_msgs = j.messages.length;
      messagesRaw = JSON.stringify(j.messages);
      prompt_chars = messagesRaw.length;
    }
    max_tokens =
      typeof j.max_tokens === "number"
        ? (j.max_tokens as number)
        : typeof j.max_completion_tokens === "number"
          ? (j.max_completion_tokens as number)
          : undefined;
  } catch {
    /* non-JSON body: metadata stays zero/undefined */
  }
  const rec: Record<string, unknown> = {
    ts: new Date(i.now).toISOString(),
    id: i.id,
    user: i.user,
    cls: i.cls,
    project: i.project,
    alias: i.alias,
    ep: i.ep,
    model: i.model,
    path: i.path,
    status: i.status,
    wait_ms: Math.max(0, i.dispatchedAt - i.enqueuedAt),
    run_ms: Math.max(0, i.now - i.dispatchedAt),
    n_msgs,
    prompt_chars,
    max_tokens,
  };
  if (i.deep && messagesRaw) {
    rec.prompt = messagesRaw.slice(0, DEEP_CAP);
    rec.truncated = messagesRaw.length > DEEP_CAP;
  }
  return rec;
}

/** Append one audit line. Logging must never break the proxy — swallow errors. */
export function appendAudit(rec: Record<string, unknown>, file: string = LOG_FILE) {
  try {
    appendFileSync(file, JSON.stringify(rec) + "\n");
  } catch {
    /* disk full / bad path — drop the line, keep serving */
  }
}

export interface Waiter {
  id: number;
  project: string;
  alias: string;
  cls: KeyClass;
  speed: number;
  candidates: string[];
  /** Stable per-conversation key for KV-cache affinity (see affinityKeyFromBody). */
  affinityKey?: string;
  enqueuedAt: number;
}

/** Cache-affinity "home" table: conversation key -> endpoint where its KV
 *  cache last lived. In-memory, LRU-bounded; a restart just means cold start. */
const HOME = new Map<string, string>();
export const HOME_CAP = 4096;

export function setHome(home: Map<string, string>, key: string, ep: string): void {
  home.delete(key);
  home.set(key, ep);
  while (home.size > HOME_CAP) {
    const oldest = home.keys().next().value;
    if (oldest === undefined) break;
    home.delete(oldest);
  }
}

/** Pick the endpoint for one waiter: the conversation's home endpoint if it
 *  is a candidate and has room, else ladder order. Home follows where the
 *  request actually lands, so warm KV tracks the serving endpoint. */
export function chooseEp(
  cands: string[],
  isFree: (e: string) => boolean,
  key: string | undefined,
  home?: Map<string, string>,
): string | undefined {
  let ep: string | undefined;
  if (key && home) {
    const h = home.get(key);
    if (h && cands.includes(h) && isFree(h)) ep = h;
  }
  ep ??= cands.find(isFree);
  if (ep !== undefined && key && home) setHome(home, key, ep);
  return ep;
}

/** Stable per-conversation key for KV-cache affinity: sha1 of the first two
 *  messages (system + first user), which never change across a conversation's
 *  turns. Undefined for non-chat bodies — those get plain ladder routing. */
export function affinityKeyFromBody(body: Buffer): string | undefined {
  try {
    const j = JSON.parse(body.toString("utf8"));
    const m = Array.isArray(j?.messages) ? j.messages : undefined;
    if (!m || m.length === 0) return undefined;
    const head = m
      .slice(0, 2)
      .map((x: { role?: string; content?: unknown }) => {
        const c = typeof x?.content === "string" ? x.content : JSON.stringify(x?.content ?? "");
        return `${x?.role ?? ""}\u0000${c.slice(0, 4096)}`;
      })
      .join("\u0001");
    return createHash("sha1").update(head).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Pure weighted dispatch — no sockets, unit-testable.
 * Splices picks out of the passed queues (UX first) and returns them with
 * their chosen endpoint (conversation home if free, else ladder order).
 * score = wait_ms * speed; tie → FIFO. speed 0 is only eligible while no
 * speed>=1 waiter exists.
 */
export function pickNext(
  ux: Waiter[],
  nonUx: Waiter[],
  avail: Record<string, number>,
  now: number,
  home?: Map<string, string>,
): Array<{ w: Waiter; ep: string }> {
  const out: Array<{ w: Waiter; ep: string }> = [];
  const anyPositive =
    ux.some((w) => w.speed > 0) || nonUx.some((w) => w.speed > 0);
  for (const q of [ux, nonUx]) {
    for (;;) {
      const cands = q.filter(
        (w) =>
          (w.speed > 0 || !anyPositive) &&
          w.candidates.some((e) => (avail[e] ?? 0) > 0),
      );
      if (cands.length === 0) break;
      let best = cands[0];
      for (const w of cands) {
        const bs = (now - best.enqueuedAt) * best.speed;
        const ws = (now - w.enqueuedAt) * w.speed;
        if (ws > bs || (ws === bs && w.enqueuedAt < best.enqueuedAt)) best = w;
      }
      const ep = chooseEp(best.candidates, (e) => (avail[e] ?? 0) > 0, best.affinityKey, home)!;
      avail[ep] = (avail[ep] ?? 0) - 1;
      q.splice(q.indexOf(best), 1);
      out.push({ w: best, ep });
    }
  }
  return out;
}

interface EpRuntime {
  def: EndpointDef;
  free: number;
  inflight: number;
  probeOk: boolean;
  breakerUntil: number;
}

interface Request extends Waiter {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  path: string;
  body: Buffer;
  user: string;
  retries: number;
  upstreamModel?: string;
  dispatchedAt?: number;
  offQ?: () => void;
}

interface InflightRow {
  id: number;
  project: string;
  alias: string;
  cls: KeyClass;
  user: string;
  ep: string;
  startedAt: number;
}

export class Switchboard {
  eps = new Map<string, EpRuntime>();
  ux: Request[] = [];
  nonUx: Request[] = [];
  inflightList: InflightRow[] = [];
  private nextId = 1;
  private onForward: (r: Request, ep: string) => void;

  constructor(cfg: SwitchboardCfg, onForward: (r: Request, ep: string) => void) {
    for (const [name, def] of Object.entries(cfg.endpoints))
      this.eps.set(name, { def, free: 0, inflight: 0, probeOk: false, breakerUntil: 0 });
    this.onForward = onForward;
  }

  id() {
    return this.nextId++;
  }
  get size() {
    return this.ux.length + this.nonUx.length;
  }
  healthy(name: string, now = Date.now()) {
    const ep = this.eps.get(name)!;
    return ep.probeOk && now >= ep.breakerUntil;
  }
  avail(name: string, now = Date.now()) {
    const ep = this.eps.get(name)!;
    return this.healthy(name, now) ? Math.max(0, ep.free - ep.inflight) : 0;
  }
  tripBreaker(name: string, now = Date.now()) {
    this.eps.get(name)!.breakerUntil = now + BREAKER_MS;
    this.sweepAllDown();
  }
  markDown(name: string) {
    this.eps.get(name)!.probeOk = false;
    this.sweepAllDown();
  }
  /** Every candidate unhealthy (breaker or probe-down) — not merely busy. */
  allDown(r: Request, now = Date.now()) {
    return r.candidates.every((n) => !this.healthy(n, now));
  }
  /** 503 a waiter whose candidates are all unhealthy — fail fast, the
   *  client can retry with backoff instead of hanging until the breaker
   *  expires. */
  rejectAllDown(r: Request) {
    const q = r.cls === "ux" ? this.ux : this.nonUx;
    const i = q.indexOf(r);
    if (i >= 0) q.splice(i, 1);
    r.offQ?.();
    r.offQ = undefined;
    if (!r.res.headersSent) {
      r.res.writeHead(503, { "content-type": "application/json" });
      r.res.end(
        JSON.stringify({
          error: `all endpoints down for ${r.project}/${r.alias}: ${r.candidates.join(", ")}`,
        }),
      );
    }
  }
  sweepAllDown() {
    for (const q of [this.ux, this.nonUx])
      for (const r of [...q]) if (this.allDown(r)) this.rejectAllDown(r);
  }

  enqueue(r: Request) {
    (r.cls === "ux" ? this.ux : this.nonUx).push(r);
    // client gave up while queued — drop just this item; the listener is
    // removed when the item leaves the queue (keep-alive sockets are reused)
    const sock = r.req.socket;
    const h = () => {
      const q = r.cls === "ux" ? this.ux : this.nonUx;
      const i = q.indexOf(r);
      if (i >= 0) q.splice(i, 1);
    };
    sock?.on("close", h);
    r.offQ = () => sock?.removeListener("close", h);
  }

  dispatch() {
    const avail: Record<string, number> = {};
    for (const n of this.eps.keys()) avail[n] = this.avail(n);
    for (const { w, ep } of pickNext(this.ux, this.nonUx, avail, Date.now(), HOME)) {
      const r = w as Request;
      r.offQ?.();
      this.onForward(r, ep);
    }
  }

  begin(r: Request, ep: string) {
    this.eps.get(ep)!.inflight++;
    this.inflightList.push({
      id: r.id,
      project: r.project,
      alias: r.alias,
      cls: r.cls,
      user: r.user,
      ep,
      startedAt: Date.now(),
    });
  }

  end(r: Request) {
    const i = this.inflightList.findIndex((x) => x.id === r.id);
    if (i >= 0) {
      this.eps.get(this.inflightList[i].ep)!.inflight--;
      this.inflightList.splice(i, 1);
    }
    this.dispatch();
  }

  /** /__queue payload — includes per-request why-waiting. */
  view(now = Date.now()) {
    const reason = (r: Request) =>
      r.candidates
        .map((n) => {
          const ep = this.eps.get(n)!;
          if (now < ep.breakerUntil)
            return `${n} breaker ${Math.ceil((ep.breakerUntil - now) / 60000)}m`;
          if (!ep.probeOk) return `${n} down`;
          if (ep.free - ep.inflight <= 0) return `${n} busy`;
          return `${n} waiting`;
        })
        .join(", ");
    const row = (r: Request) => ({
      id: r.id,
      project: r.project,
      alias: r.alias,
      class: r.cls,
      user: r.user,
      wait_ms: now - r.enqueuedAt,
      score: (now - r.enqueuedAt) * r.speed,
      candidates: r.candidates,
      reason: reason(r),
    });
    return {
      queue: [...this.ux, ...this.nonUx].map(row),
      inflight: this.inflightList.map((x) => ({ ...x, elapsed_ms: now - x.startedAt })),
      endpoints: Object.fromEntries(
        [...this.eps].map(([n, e]) => [
          n,
          {
            healthy: this.healthy(n, now),
            free: e.free,
            inflight: e.inflight,
            breaker_until_ms: now < e.breakerUntil ? e.breakerUntil : null,
          },
        ]),
      ),
    };
  }
}

function loadConfig(file?: string): SwitchboardCfg {
  const path =
    file ??
    join(fileURLToPath(new URL(".", import.meta.url)), "switchboard.default.json");
  const cfg = JSON.parse(readFileSync(path, "utf8")) as SwitchboardCfg;
  // relative authFile resolves against the working dir (systemd sets WorkingDirectory);
  // token read at boot — missing key file crashes startup (loud, not per-request)
  for (const d of Object.values(cfg.endpoints))
    if (d.authFile) {
      if (!d.authFile.startsWith("/")) d.authFile = join(process.cwd(), d.authFile);
      d.authToken = readFileSync(d.authFile, "utf8").trim();
    }
  return cfg;
}

function loadKeys(file: string | undefined): Map<string, KeyInfo> | null {
  if (!file) return null;
  const j = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    string | { user: string; class?: string; lane?: string }
  >;
  const m = new Map<string, KeyInfo>();
  for (const [k, v] of Object.entries(j))
    m.set(
      k,
      typeof v === "string"
        ? { user: v, cls: "ux" }
        : {
            user: v.user,
            cls: v.class === "non-ux" ? "non-ux" : "ux",
            lane: v.lane === "private" || v.lane === "public" ? v.lane : undefined,
          },
    );
  return m;
}

/**
 * T09 lane check — pure, unit-testable. Instance lane (LANE env) vs key binding.
 * Fail-closed: a labeled instance rejects any internal key without a lane;
 * external passthrough keys are public-only (rejected on the private lane).
 * Returns an error message, or null when allowed.
 */
export function laneCheck(lane: Lane | undefined, info: KeyInfo): string | null {
  if (!lane) return null;
  if (info.external) return lane === "private" ? "external passthrough keys are not accepted on the private lane" : null;
  if (!info.lane) return `unlabeled key (${info.user}) — fail-closed; add "lane" to the key entry`;
  return info.lane === lane ? null : `key lane '${info.lane}' does not match instance lane '${lane}'`;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
export function startServer(keysFile?: string, configFile?: string) {
  const LANE = (process.env.LANE === "private" || process.env.LANE === "public" ? process.env.LANE : undefined) as Lane | undefined;
  const cfg = loadConfig(configFile ?? process.env.CONFIG_FILE);
  // Local GGUF models join the same config the Switchboard is built from, so
  // `<project>/<gguf-id>` routes like any other alias. Inert (returns []) with
  // no deploy/local-llm.json.
  const localFiles = localLlm.register(cfg);
  const keys = loadKeys(keysFile ?? process.env.KEYS_FILE);
  if (keys) console.log(`${keys.size} api key(s) loaded`);
  else console.log("no KEYS_FILE — open mode (X-User header, no auth)");
  console.log(
    `endpoints: ${Object.entries(cfg.endpoints).map(([n, e]) => `${n}→${e.url}${e.uxOnly ? " (ux-only)" : ""}`).join(", ")}`,
  );
  console.log(
    `aliases: ${Object.entries(cfg.aliases).map(([a, l]) => `${a}=[${l.join(" > ")}]`).join(", ")}`,
  );
  console.log(
    `projects: ${Object.entries(cfg.projects).map(([p, d]) => `${p}(speed ${d.speed}, [${d.mask.join(",")}])`).join(", ")}`,
  );
  if (localFiles.length)
    console.log(`local-llm: ${localFiles.length} gguf model(s) — ${localFiles.map((f) => f.id).join(", ")}`);

  const capFor = (cls: KeyClass) => cfg.maxTokens?.[cls] ?? DEFAULT_CAP;

  // Audit mode: shallow always on; deep arms for the next N requests.
  const audit = { deepRemaining: 0, totalLogged: 0 };
  const auditState = () => ({
    mode: audit.deepRemaining > 0 ? "deep" : "shallow",
    deep_remaining: audit.deepRemaining,
    log_file: LOG_FILE,
    total_logged: audit.totalLogged,
  });

  const sb = new Switchboard(cfg, (r, ep) => {
    sb.begin(r, ep);
    forward(r, ep);
  });

  // local-llm owns spawn/kill; the switchboard only needs the health delta.
  // onReady marks the endpoint usable immediately — otherwise the first request
  // after a cold load races the 2 s probe and 503s. isBusy reuses the
  // switchboard's own inflight count so a model mid-stream is never evicted.
  localLlm.onReady = (name, slots) => {
    const ep = sb.eps.get(name);
    if (!ep) return;
    ep.probeOk = true;
    ep.breakerUntil = 0;
    ep.free = slots;
    sb.dispatch();
  };
  localLlm.onDown = (name) => { if (sb.eps.has(name)) sb.markDown(name); };
  localLlm.isBusy = (name) => (sb.eps.get(name)?.inflight ?? 0) > 0;

  function forward(r: Request, epName: string) {
    const ep = sb.eps.get(epName)!;
    r.dispatchedAt = Date.now();
    const u = new URL(ep.def.url);
    // rewrite at dispatch time — the model depends on which endpoint won.
    // passthrough endpoints honor the combo suffix (pool/<model>) when present.
    const body = rewriteBody(
      r.body,
      ep.def.authPassthrough ? (r.upstreamModel ?? ep.def.model) : ep.def.model,
      capFor(r.cls),
    );
    // upstream auth (if configured) overrides the client's factory key —
    // except passthrough: the caller's own key flows through untouched and the
    // upstream authenticates it (authToken is probe-only there).
    const auth =
      ep.def.authToken && !ep.def.authPassthrough
        ? { authorization: `Bearer ${ep.def.authToken}` }
        : {};
    const out = (u.protocol === "https:" ? https : http).request(
      {
        hostname: u.hostname,
        port: u.port,
        method: r.req.method,
        path: (ep.def.prefix ?? "") + r.path,
        headers: {
          ...r.req.headers,
          host: u.host,
          "content-length": body.length,
          "x-user": r.user,
          ...auth,
        },
      },
      (up) => {
        const st = up.statusCode ?? 502;
        if (st === 429 || st >= 500) sb.tripBreaker(epName);
        r.res.writeHead(st, { ...up.headers, "x-resolved-model": ep.def.model });
        // Fork A: repair M3's XML tool-call leak on streaming chat responses
        // that carry tools (leak → dead turn; truncation → poisoned stream
        // client). Everything else pipes bytes through untouched.
        let wantsFix = false;
        if (String(up.headers["content-type"] ?? "").includes("text/event-stream")) {
          try {
            const rq = JSON.parse(body.toString("utf8"));
            wantsFix = rq?.stream === true && Array.isArray(rq?.tools) && rq.tools.length > 0;
          } catch {
            /* unparseable body → passthrough */
          }
        }
        if (wantsFix) up.pipe(new SseToolCallFixer()).pipe(r.res);
        else up.pipe(r.res);
        const deep = audit.deepRemaining > 0;
        if (deep) audit.deepRemaining--;
        audit.totalLogged++;
        appendAudit(
          buildAuditRecord({
            id: r.id, user: r.user, cls: r.cls, project: r.project, alias: r.alias,
            ep: epName, model: ep.def.model, path: r.path, status: st,
            enqueuedAt: r.enqueuedAt, dispatchedAt: r.dispatchedAt ?? r.enqueuedAt,
            body: r.body, now: Date.now(), deep,
          }),
        );
      },
    );
    out.on("error", (e) => {
      // connect-level failure: mark down (probe may be stale) and requeue
      // for the next candidate while retries remain — pre-response, so the
      // client has seen nothing and failover is safe
      sb.markDown(epName);
      if (!r.res.headersSent && r.retries < r.candidates.length) {
        r.retries++;
        sb.enqueue(r); // enqueuedAt preserved — wait credit kept
        if (sb.allDown(r)) {
          sb.rejectAllDown(r); // no healthy candidate left — fail fast
          return;
        }
        return; // out "close" fires end() → dispatch()
      }
      r.res.writeHead(502, { "content-type": "text/plain" });
      r.res.end(`bad gateway: ${e.message}`);
    });
    const sock = r.req.socket;
    const h = () => out.destroy();
    sock?.on("close", h);
    out.on("close", () => {
      sock?.removeListener("close", h);
      sb.end(r);
    });
    out.end(body);
  }

  http
    .createServer(async (req, res) => {
      // /health is always open — tunnel/LB health checks carry no keys
      if (req.url === "/health") {
        const eps: Record<string, boolean> = {};
        for (const n of sb.eps.keys()) eps[n] = sb.healthy(n);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, endpoints: eps }));
        return;
      }
      // public readme for pool users — no auth (it explains how to GET a key)
      if (req.url === "/pool/" || req.url === "/pool/index.html") {
        try {
          const html = readFileSync(
            join(fileURLToPath(new URL(".", import.meta.url)), "deploy/pool/index.html"),
          );
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
        } catch {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("readme missing");
        }
        return;
      }
      const rawAuth = req.headers.authorization ?? req.headers["x-api-key"];
      const rawTok = ((Array.isArray(rawAuth) ? rawAuth[0] : rawAuth) ?? "").replace(/^Bearer\s*/i, "").trim();
      let info = authUser(req.headers, keys);
      if (info === null && keys) {
        // unknown-but-present bearer → external identity; only passthrough
        // endpoints will serve it, and the upstream validates the key itself.
        const tok = rawTok;
        if (tok)
          info = {
            user: "ext-" + createHash("sha256").update(tok).digest("hex").slice(0, 8),
            cls: "ux",
            external: true,
          };
      }
      if (info === null) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid or missing api key" }));
        return;
      }
      // T09 lane check — fail-closed ingress enforcement
      const laneErr = laneCheck(LANE, info);
      if (laneErr) {
        res.writeHead(403, {
          "content-type": "application/json",
          "x-lane": LANE ?? "unset",
        });
        res.end(JSON.stringify({ error: `lane check: ${laneErr}` }));
        return;
      }
      if (req.url === "/v1/models") {
        // Full shop window: auto-llm itself, the local GGUF engines, every
        // 9router combo and every 9router model — each listed under an id this
        // key can ACTUALLY call. The old listing emitted bare arm ids like
        // "ali/qwen3.7-max", which parseModel reads as project "ali" and
        // rejects, so ~every advertised model was uncallable.
        const live = await autoLlm.models().catch(() => null);
        if (live) {
          // parseModel is the oracle: it already knows masks, uxOnly and the
          // external→passthrough rule, so don't restate them here.
          const callable = (alias: string): string[] =>
            Object.entries(cfg.projects)
              .filter(([, pd]) => pd.mask.includes(alias))
              .map(([p]) => `${p}/${alias}`)
              .filter((id) => !("error" in parseModel(id, cfg, info.cls, info.external)));
          const defProj = cfg.defaultProject ?? Object.keys(cfg.projects)[0];
          // prefer the caller's default project for the primary id
          const pick = (ids: string[]): string =>
            ids.find((i) => i.startsWith(defProj + "/")) ?? ids[0] ?? "";

          type Entry = Record<string, unknown> & { id: string; object: string };
          const data: Entry[] = [];

          const llmIds = callable("auto-llm");
          const localIds = new Map(live.local.map((l) => [l.id, callable(l.id)]));
          const poolIds = callable("pool");
          const poolBase = pick(poolIds);
          // parseModel accepting an id is not the same as the id WORKING. A
          // passthrough alias forwards the CALLER's bearer (forward() skips
          // authToken/authFile when authPassthrough), so an internal proxy key
          // gets 401 from 9router on every pool id. Only callers who can
          // present the upstream key get the 703 pool entries listed; everyone
          // else gets one honest top-level note instead of 703 dead ids.
          const poolPassthrough = (cfg.aliases["pool"] ?? []).every(
            (n) => cfg.endpoints[n]?.authPassthrough,
          );
          const poolUsable = !!poolBase && !(poolPassthrough && !info.external);

          // 1. the router itself
          if (llmIds.length)
            data.push({
              id: pick(llmIds), object: "model", owned_by: "arc-llm-proxy",
              also: llmIds.filter((i) => i !== pick(llmIds)),
              kind: "router",
              universe: live.data.length + live.cooling.length,
              cooling: live.cooling,
              local_arms: live.local.length,
              description:
                "auto-llm — Thompson-sampling router; picks the arm for you " +
                `(${live.data.length} explorable cloud arms + ${live.local.length} local)`,
            });

          // 2. local GGUF engines (electricity-priced, measured)
          for (const l of live.local) {
            const ids = localIds.get(l.id) ?? [];
            if (!ids.length) continue;      // not callable with this key class
            data.push({
              id: pick(ids), object: "model", owned_by: "local-gguf", kind: "local",
              also: ids.filter((i) => i !== pick(ids)),
              arm: l.arm, warm: l.warm,
              price_per_1m_tokens: l.price1M,
              measured_tps: l.tps, measured_watts: l.watts,
              description:
                `local GGUF on the V100 — $${(l.price1M ?? 0).toFixed(4)}/1M tokens ` +
                (l.warm ? "(resident)" : "(cold: includes swap delay)"),
            });
          }

          // 3. every 9router combo + model, via the passthrough pool
          for (const m of live.catalog) {
            if (!poolUsable) break;         // this key can't reach the pool at all
            const id = `${poolBase}/${m.id}`;
            data.push({
              id, object: "model", owned_by: m.owned_by || "9router",
              kind: m.combo ? "combo" : "9router",
              also: poolIds.filter((p) => `${p}/${m.id}` !== id).map((p) => `${p}/${m.id}`),
              upstream: m.id, via: "pool",
              auto_llm: m.arm, ...(m.cooling ? { cooling: true } : {}),
              ...(m.excluded ? { excluded: m.excluded } : {}),
              description: m.combo
                ? "9router combo preset"
                : m.arm
                  ? "9router model — auto-llm may route here"
                  : `9router model — callable directly, not in the auto-llm universe (${m.excluded})`,
            });
          }

          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            object: "list",
            data,
            cooling: live.cooling,
            ...(poolUsable
              ? {}
              : {
                  pool: {
                    hidden: live.catalog.length,
                    id_form: poolBase ? `${poolBase}/<9router-model>` : "<project>/pool/<9router-model>",
                    reason: poolBase
                      ? "the pool alias is auth-passthrough: these ids need your own 9router " +
                        "key as the bearer token. Present it and they are listed here."
                      : "this key cannot reach the pool alias",
                  },
                }),
            counts: {
              // derived from `data`, never from the catalogs: a count that
              // disagrees with what this key was actually shown is a lie.
              listed: data.length,
              combos: data.filter((e) => e.kind === "combo").length,
              "9router_models": data.filter((e) => e.kind === "9router").length,
              local: data.filter((e) => e.kind === "local").length,
              auto_llm_arms: live.data.length + live.cooling.length,
            },
          }));
          return;
        }
        const data: Array<{ id: string; object: string; description: string }> = [];
        for (const [p, pd] of Object.entries(cfg.projects))
          for (const a of pd.mask)
            data.push({
              id: `${p}/${a}`,
              object: "model",
              description: `project ${p} (speed ${pd.speed}) via ${a}`,
            });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data }));
        return;
      }
      // --- local-llm admin: inventory, live engines, measured tps/watts/$.
      // Same protection as /__queue — past the key + lane gate, no extra auth.
      if (req.url === "/__local") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(localLlm.view()));
        return;
      }
      if (req.url?.startsWith("/__local/")) {
        const u = new URL(req.url, "http://local");
        const id = u.searchParams.get("id");
        const out = !id
          ? { ok: false, error: "id required" }
          : u.pathname === "/__local/load"
            ? await localLlm.ensure(id)
            : u.pathname === "/__local/unload"
              ? await localLlm.unload(id)
              : { ok: false, error: `unknown action ${u.pathname}` };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }
      if (req.url === "/__queue") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(sb.view()));
        return;
      }
      if (req.url === "/__audit") {
        if (req.method === "POST") {
          const b = await readBody(req);
          let j: { mode?: string; n?: number } = {};
          try {
            j = JSON.parse(b.toString("utf8"));
          } catch {
            /* ignore malformed body */
          }
          if (j.mode === "deep") audit.deepRemaining = Math.max(0, Number(j.n) || 0);
          else if (j.mode === "shallow") audit.deepRemaining = 0;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(auditState()));
        return;
      }
      const body = await readBody(req);
      let json: { model?: unknown } | undefined;
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        // fall through — model will be undefined → 400
      }
      const model = typeof json?.model === "string" ? json.model : undefined;
      if (!model) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "body must be JSON with a model field" }));
        return;
      }
      const parsed = parseModel(model, cfg, info.cls, info.external);
      if ("error" in parsed) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: parsed.error }));
        return;
      }
      // A local GGUF is loaded on demand — the first request pays the swap.
      // Must run before allDown(): an unloaded engine probes down, so skipping
      // this would 503 the model exactly when someone asks for it.
      for (const n of parsed.candidates) {
        const lid = localLlm.idForEndpoint(n);
        if (!lid) continue;
        const up = await localLlm.ensure(lid);
        if (!up.ok) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: up.error ?? `local engine ${lid} unavailable` }));
          return;
        }
      }
      // T04 auto-llm: classify → Thompson-sample the live model universe per
      // task class → exploit stream-through / explore with judge approve-deny.
      // No config → handle() returns false → falls through to the alias ladder.
      // parseModel already restricted external users to passthrough endpoints.
      // auto-llm must never be able to kill the proxy: a throw here (dead
      // upstream, unreadable key file) degrades to the normal alias ladder
      // below rather than escaping as an unhandled rejection.
      if (parsed.alias === "auto-llm") {
        let handled = false;
        try {
          handled = await autoLlm.handle(req, res, body, info.user, info.external ? rawTok : "");
        } catch (e) {
          console.log(`auto-llm handle failed, falling through: ${String(e)}`);
          if (res.headersSent || res.writableEnded) return; // partial response — can't recover
        }
        if (handled) return;
      }
      const r: Request = {
        id: sb.id(),
        req,
        res,
        path: req.url ?? "/",
        body,
        user: info.user,
        cls: info.cls,
        project: parsed.project,
        alias: parsed.alias,
        candidates: parsed.candidates,
        upstreamModel: parsed.upstreamModel,
        affinityKey: affinityKeyFromBody(body),
        enqueuedAt: Date.now(),
        speed: cfg.projects[parsed.project].speed,
        retries: 0,
      };
      if (sb.allDown(r)) {
        sb.rejectAllDown(r);
        return;
      }
      // zero-wait path: nothing queued and a candidate has a free slot
      // → dispatch immediately instead of waiting for the next tick
      if (sb.size === 0) {
        const ep = chooseEp(r.candidates, (n) => sb.avail(n) > 0, r.affinityKey, HOME);
        if (ep) {
          sb.begin(r, ep);
          forward(r, ep);
          return;
        }
      }
      sb.enqueue(r);
      sb.dispatch();
    })
    .listen(PORT, HOST, () =>
      console.log(`switchboard :${PORT} — ${sb.eps.size} endpoint(s), probe every ${POLL_MS}ms`),
    );

  // Last-resort backstop: one dead upstream arm must never take the silo down
  // for every other caller. Log and keep serving — a proxy that is up and
  // failing one route beats a proxy in a systemd restart loop.
  process.on("unhandledRejection", (e: unknown) => console.log(`unhandledRejection (ignored): ${String(e)}`));
  process.on("uncaughtException", (e: unknown) => console.log(`uncaughtException (ignored): ${String(e)}`));

  // A proxy restart must not orphan a 16 GB engine holding the GPU — unload on
  // the way out so the next start has VRAM.
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.on(sig, () => { void localLlm.stop().finally(() => process.exit(0)); });

  async function probe() {
    for (const [name, ep] of sb.eps) {
      if (ep.def.probe === "models") {
        // OpenAI-compat upstream: no /slots — 200 on /models means up, fixed concurrency
        try {
          // auth: inline authToken or key file (probe must auth like calls do)
          const probeTok = ep.def.authToken
            ?? (ep.def.authFile ? readFileSync(ep.def.authFile, "utf8").trim() : undefined);
          const r = await fetch(
            ep.def.url.replace(/\/+$/, "") + (ep.def.prefix ?? "") + "/v1/models",
            {
            signal: AbortSignal.timeout(3000),
            headers: probeTok ? { authorization: `Bearer ${probeTok}` } : {},
          });
          ep.probeOk = r.ok;
          if (r.ok) ep.free = ep.def.slots ?? 2;
        } catch {
          ep.probeOk = false;
        }
        continue;
      }
      try {
        const r = await fetch(ep.def.url + "/slots", { signal: AbortSignal.timeout(3000) });
        if (!r.ok) {
          ep.probeOk = false;
          continue;
        }
        const text = await r.text();
        let j: unknown;
        try {
          j = JSON.parse(text);
        } catch {
          // 200 but not JSON — treat as a single opaque slot
          ep.probeOk = true;
          ep.free = 1;
          continue;
        }
        const arr = Array.isArray(j) ? j : ((j as { slots?: unknown[] }).slots ?? []);
        ep.free = arr.filter((s) => {
          const x = s as { state?: string; is_processing?: boolean };
          // llama-server builds differ: some expose state, some only is_processing
          return x.state ? x.state === "idle" : !x.is_processing;
        }).length;
        ep.probeOk = true;
      } catch {
        ep.probeOk = false;
      }
    }
    sb.sweepAllDown();
    sb.dispatch();
  }
  setInterval(probe, POLL_MS);
  void probe();
}

// run only when executed directly (not imported by tests)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
