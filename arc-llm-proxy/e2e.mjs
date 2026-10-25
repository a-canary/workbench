// E2E: two mock endpoints (+ one ux-only) + real switchboard proxy.
//   0. auth gate: no/bad key 401; /health open; /__queue key-gated
//   1. /v1/models lists project/alias pairs
//   2. routing: project/alias → upstream model rewrite + x-resolved-model,
//      zero-wait immediate dispatch when a slot is free
//   3. ladder failover on busy, then on endpoint down (probe)
//   4. breaker: 429 marks endpoint unhealthy, next request fails over
//   5. weighted dispatch: wait*speed beats earlier arrival
//   6. UX queue drains before non-UX; speed 0 only when no positive waits
//   7. per-class max_tokens cap enforced at the proxy
//   8. 400s: non-ux + ux-only alias, unknown project
//   9. bare alias → default project (non-strict compat)
//  10. /__queue why-waiting + inflight rows
//  11. disconnected client dropped from queue
import http from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const P1 = 18201, P2 = 18202, P3 = 18203, PP = 18204;

function makeUpstream(port, model, state) {
  const srv = http.createServer((req, res) => {
    if (req.url === "/slots") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(
        Array.from({ length: state.total }, (_, i) => ({ id: i, is_processing: i >= state.idle })),
      ));
      return;
    }
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      let j = {};
      try { j = JSON.parse(b); } catch {}
      state.seen.push({ model: j.model, user: req.headers["x-user"] ?? "?", max_tokens: j.max_tokens, content: j.content });
      if (state.failNext > 0) {
        state.failNext--;
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      if (j.hold) { state.held.push(res); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: `mock-${model}` } }] }));
    });
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
}

const s1 = { idle: 0, total: 1, failNext: 0, seen: [], held: [] };
const s2 = { idle: 0, total: 1, failNext: 0, seen: [], held: [] };
const s3 = { idle: 1, total: 1, failNext: 0, seen: [], held: [] };
let srv1 = await makeUpstream(P1, "Model-E1", s1);
let srv2 = await makeUpstream(P2, "Model-E2", s2);
await makeUpstream(P3, "Claude-Mock", s3);

const dir = mkdtempSync(join(tmpdir(), "arc-llm-proxy-"));
writeFileSync(join(dir, "keys.json"), JSON.stringify({
  "k-alice": { user: "alice", class: "ux" },
  "k-bob": { user: "bob", class: "non-ux" },
  "k-carol": "carol", // string form → class ux
}));
writeFileSync(join(dir, "cfg.json"), JSON.stringify({
  endpoints: {
    e1: { url: `http://127.0.0.1:${P1}`, model: "Model-E1" },
    e2: { url: `http://127.0.0.1:${P2}`, model: "Model-E2" },
    eclaude: { url: `http://127.0.0.1:${P3}`, model: "Claude-Mock", uxOnly: true },
  },
  aliases: { easy: ["e1", "e2"], hard: ["eclaude"] },
  projects: {
    default: { speed: 1, mask: ["easy", "hard"] },
    urgent: { speed: 8, mask: ["easy"] },
    idle: { speed: 0, mask: ["easy"] },
  },
  maxTokens: { ux: 16384, "non-ux": 4096 },
  defaultProject: "default",
  strict: false,
}));

process.env.PORT = String(PP);
process.env.POLL_MS = "500";
process.env.BREAKER_MS = "1000";
process.env.KEYS_FILE = join(dir, "keys.json");
process.env.CONFIG_FILE = join(dir, "cfg.json");
const proxy = await import("./server.ts");
proxy.startServer();
await new Promise((r) => setTimeout(r, 300)); // bind + first probe

const post = (model, obj, key) =>
  new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const t0 = Date.now();
    const r = http.request(`http://127.0.0.1:${PP}/v1/chat/completions`,
      { method: "POST", headers }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode, body: b, headers: res.headers, ms: Date.now() - t0 }));
      });
    r.on("error", reject);
    r.end(JSON.stringify({ model, ...obj }));
  });
const get = (url, key) =>
  new Promise((resolve, reject) => {
    const headers = {};
    if (key) headers.authorization = `Bearer ${key}`;
    http.get(`http://127.0.0.1:${PP}${url}`, { headers }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    }).on("error", reject);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

// 0. auth gate
check("missing key → 401", (await post("urgent/easy", {}, null)).status === 401);
check("bad key → 401", (await post("urgent/easy", {}, "k-nope")).status === 401);
const h = await get("/health");
check("/health open, reports endpoints", h.status === 200 && JSON.parse(h.body).endpoints.e1 === true);
check("/__queue bad key → 401", (await get("/__queue", "k-nope")).status === 401);
check("/__queue good key → 200", (await get("/__queue", "k-alice")).status === 200);

// 1. /v1/models: project/alias pairs
const m = JSON.parse((await get("/v1/models", "k-alice")).body).data;
check("/v1/models lists project/alias pairs",
  JSON.stringify(m.map((x) => x.id).sort()) ===
  JSON.stringify(["default/easy", "default/hard", "idle/easy", "urgent/easy"].sort()));
check("/v1/models carries description", m.every((x) => typeof x.description === "string" && x.description.length > 5));

// 2. routing + rewrite + zero-wait immediate dispatch
s1.idle = 1;
await sleep(600); // let a probe see e1 free
const lat = [];
for (let i = 0; i < 5; i++) lat.push((await post("urgent/easy", { content: "hi" }, "k-alice")).ms);
check("immediate dispatch with free slot: max latency < 250ms (poll is 500ms)",
  Math.max(...lat) < 250);
check("upstream got rewritten model, never the alias path",
  s1.seen.every((x) => x.model === "Model-E1"));
const r2 = await post("urgent/easy", { content: "hi" }, "k-alice");
check("x-resolved-model header set", r2.headers["x-resolved-model"] === "Model-E1");
check("upstream x-user is the key's user", s1.seen.every((x) => x.user === "alice"));

// 3. ladder failover: e1 busy → e2
s1.idle = 0; s2.idle = 1;
await sleep(600);
const r3 = await post("urgent/easy", { content: "hi" }, "k-alice");
check("busy top-of-ladder fails over to next endpoint", r3.headers["x-resolved-model"] === "Model-E2");
check("failover response came from e2", r3.body.includes("mock-Model-E2"));

// 4. breaker: e1 429s once → unhealthy → next request goes to e2
s1.idle = 1; s1.failNext = 1;
await sleep(600);
const r4 = await post("default/easy", { content: "hi" }, "k-bob");
check("429 passes through to client", r4.status === 429);
const r5 = await post("urgent/easy", { content: "hi" }, "k-alice");
check("after 429 breaker, request fails over to e2", r5.headers["x-resolved-model"] === "Model-E2");
await sleep(1200); // breaker (1000ms) expires

// endpoint down: close e2 → probe marks it down → e1 serves
srv2.close();
await sleep(700);
const r6 = await post("urgent/easy", { content: "hi" }, "k-alice");
check("endpoint down → probe marks down → e1 serves", r6.headers["x-resolved-model"] === "Model-E1");

// 5. weighted dispatch: bob (speed 1) queued first, alice (speed 8) 300ms later
s1.idle = 0;
await sleep(600);
s1.seen.length = 0;
const pBob = post("default/easy", { content: "bob" }, "k-bob");
await sleep(300);
const pAlice = post("urgent/easy", { content: "alice" }, "k-alice");
await sleep(600); // both queued, a poll passes with idle=0
s1.idle = 1;
await Promise.all([pAlice, pBob]);
check("weighted: wait*speed beats earlier arrival",
  s1.seen.length === 2 && s1.seen[0].content === "alice" && s1.seen[1].content === "bob");

// 6a. UX drains before non-UX (same speed, UX arrived later)
s1.idle = 0;
await sleep(600);
s1.seen.length = 0;
const pBob2 = post("default/easy", { content: "bob" }, "k-bob");
await sleep(100);
const pAlice2 = post("default/easy", { content: "alice" }, "k-alice");
await sleep(600);
s1.idle = 1;
await Promise.all([pAlice2, pBob2]);
check("UX queue drains before non-UX", s1.seen[0].content === "alice" && s1.seen[1].content === "bob");

// 6b. speed 0 dispatches when nothing positive waits
s1.idle = 0;
await sleep(600);
s1.seen.length = 0;
const pIdle = post("idle/easy", { content: "idle" }, "k-carol");
await sleep(600);
s1.idle = 1;
await pIdle;
check("speed 0 dispatches when no speed>=1 waits", s1.seen[0]?.content === "idle");

// 7. per-class max_tokens cap
s1.idle = 1;
await sleep(600);
s1.seen.length = 0;
await post("default/easy", { max_tokens: 99999 }, "k-alice"); // ux → 16384
await post("default/easy", { max_tokens: 99999 }, "k-bob");   // non-ux → 4096
check("ux max_tokens clamped to 16384", s1.seen[0]?.max_tokens === 16384);
check("non-ux max_tokens clamped to 4096", s1.seen[1]?.max_tokens === 4096);

// 8. 400s
const r8 = await post("default/hard", {}, "k-bob");
check("non-ux + ux-only alias → 400 with reason",
  r8.status === 400 && r8.body.includes("ux-only"));
const r8b = await post("nope/easy", {}, "k-alice");
check("unknown project → 400 listing known",
  r8b.status === 400 && r8b.body.includes("unknown project") && r8b.body.includes("urgent"));

// 9. bare alias → default project (non-strict)
s1.idle = 1;
const r9 = await post("easy", { content: "bare" }, "k-carol");
check("bare alias works via default project", r9.status === 200 && r9.body.includes("mock-Model-E1"));

// 10. /__queue why-waiting + inflight
s1.idle = 1; // hold gets dispatched (inflight=1), waiter then sees e1 busy
await sleep(600);
const pHold = post("default/easy", { hold: true }, "k-bob");
const pWait = post("default/easy", { content: "wait" }, "k-alice");
await sleep(700);
let q = JSON.parse((await get("/__queue", "k-alice")).body);
check("/__queue shows queued request with why-waiting",
  q.queue.length === 1 && q.queue[0].reason.includes("e1 busy") && q.queue[0].reason.includes("e2 down"));
check("/__queue shows inflight row with endpoint",
  q.inflight.length === 1 && q.inflight[0].ep === "e1");
for (const r of s1.held.splice(0)) {
  r.writeHead(200, { "content-type": "application/json" });
  r.end(JSON.stringify({ choices: [] }));
}
await Promise.all([pHold, pWait]);
q = JSON.parse((await get("/__queue", "k-alice")).body);
check("queue drained after release", q.queue.length === 0 && q.inflight.length === 0);

// 11. disconnected client dropped from queue
s1.idle = 0;
await sleep(600);
const req = http.request(`http://127.0.0.1:${PP}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer k-alice" },
});
req.on("error", () => {});
req.end(JSON.stringify({ model: "default/easy", messages: [] }));
await sleep(300);
req.destroy();
await sleep(300);
q = JSON.parse((await get("/__queue", "k-alice")).body);
check("disconnected client dropped from queue", q.queue.length === 0);

// 12. all candidates down → immediate 503 (fail fast, no 5-min hang)
srv1.close(); // e2 already closed in section 4
await sleep(700); // probe marks e1 down
const r12 = await post("default/easy", { content: "hi" }, "k-alice");
check("all endpoints down → 503 fail-fast",
  r12.status === 503 && r12.body.includes("all endpoints down for default/easy"));

console.log(failures === 0 ? "E2E OK" : `E2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
