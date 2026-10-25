// Unit tests for the pure switchboard core: parseModel, authUser,
// rewriteBody, pickNext. No sockets.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseModel,
  authUser,
  rewriteBody,
  pickNext,
  buildAuditRecord,
  chooseEp,
  setHome,
  affinityKeyFromBody,
  HOME_CAP,
} from "./server.ts";
import type { SwitchboardCfg, Waiter } from "./server.ts";

const cfg: SwitchboardCfg = {
  endpoints: {
    e1: { url: "http://a:1", model: "M1" },
    e2: { url: "http://b:2", model: "M2" },
    eclaude: { url: "http://c:3", model: "CC", uxOnly: true },
  },
  aliases: {
    easy: ["e1", "e2"],
    mid: ["e2", "e1"],
    hard: ["eclaude"],
  },
  projects: {
    default: { speed: 1, mask: ["easy", "mid", "hard"] },
    urgent: { speed: 8, mask: ["easy", "mid"] },
    idle: { speed: 0, mask: ["easy"] },
  },
  defaultProject: "default",
  strict: false,
};

// ---------- parseModel ----------

test("parseModel: project/alias resolves with ladder-order candidates", () => {
  const r = parseModel("urgent/easy", cfg, "ux");
  assert.deepEqual(r, { project: "urgent", alias: "easy", candidates: ["e1", "e2"] });
});

test("parseModel: bare alias → default project (non-strict)", () => {
  const r = parseModel("easy", cfg, "ux");
  assert.ok("project" in r && r.project === "default" && r.alias === "easy");
});

test("parseModel: bare alias rejected in strict mode", () => {
  const r = parseModel("easy", { ...cfg, strict: true }, "ux");
  assert.ok("error" in r && r.error.includes("strict"));
});

test("parseModel: unknown project → descriptive error listing known", () => {
  const r = parseModel("nope/easy", cfg, "ux");
  assert.ok("error" in r && r.error.includes("unknown project") && r.error.includes("urgent"));
});

test("parseModel: unknown alias → descriptive error", () => {
  const r = parseModel("default/nope", cfg, "ux");
  assert.ok("error" in r && r.error.includes("unknown alias"));
});

test("parseModel: alias outside project mask → error with mask", () => {
  const r = parseModel("idle/hard", cfg, "ux");
  assert.ok("error" in r && r.error.includes("may not use alias") && r.error.includes("mask: easy"));
});

test("parseModel: non-ux key drops uxOnly endpoints from ladder", () => {
  const r = parseModel("default/easy", cfg, "non-ux");
  assert.ok("candidates" in r && r.candidates.includes("e1") && r.candidates.includes("e2"));
  const h = parseModel("default/hard", cfg, "non-ux");
  assert.ok("error" in h && h.error.includes("ux-only"));
});

test("parseModel: ux key keeps uxOnly endpoints", () => {
  const r = parseModel("default/hard", cfg, "ux");
  assert.ok("candidates" in r && r.candidates[0] === "eclaude");
});

// ---------- authUser ----------

const keys = new Map([
  ["k-alice", { user: "alice", cls: "ux" as const }],
  ["k-bob", { user: "bob", cls: "non-ux" as const }],
]);

test("authUser: bearer token → key info", () => {
  assert.deepEqual(authUser({ authorization: "Bearer k-bob" }, keys), { user: "bob", cls: "non-ux" });
});

test("authUser: x-api-key header works", () => {
  assert.deepEqual(authUser({ "x-api-key": "k-alice" }, keys), { user: "alice", cls: "ux" });
});

test("authUser: bad/missing token → null", () => {
  assert.equal(authUser({ authorization: "Bearer k-nope" }, keys), null);
  assert.equal(authUser({}, keys), null);
});

test("authUser: open mode → X-User or default, class ux", () => {
  assert.deepEqual(authUser({ "x-user": "carol" }, null), { user: "carol", cls: "ux" });
  assert.deepEqual(authUser({}, null), { user: "default", cls: "ux" });
});

// ---------- rewriteBody ----------

test("rewriteBody: sets upstream model, clamps max_tokens to cap", () => {
  const out = JSON.parse(rewriteBody(Buffer.from('{"model":"x","max_tokens":99999}'), "M1", 4096).toString());
  assert.equal(out.model, "M1");
  assert.equal(out.max_tokens, 4096);
});

test("rewriteBody: clamps max_completion_tokens too; leaves under-cap alone", () => {
  const out = JSON.parse(rewriteBody(Buffer.from('{"model":"x","max_tokens":100,"max_completion_tokens":99999}'), "M1", 4096).toString());
  assert.equal(out.max_tokens, 100);
  assert.equal(out.max_completion_tokens, 4096);
});

test("rewriteBody: non-JSON body passes through", () => {
  const b = Buffer.from("not json");
  assert.equal(rewriteBody(b, "M1", 100), b);
});

test("rewriteBody: developer role normalized to system (tokenrouter 400s on developer)", () => {
  const out = JSON.parse(rewriteBody(
    Buffer.from('{"model":"x","messages":[{"role":"developer","content":"a"},{"role":"user","content":"b"}]}'),
    "M1", 4096).toString());
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[0].content, "a");
  assert.equal(out.messages[1].role, "user");
});

// ---------- pickNext ----------

const w = (over: Partial<Waiter> & Pick<Waiter, "id" | "speed" | "enqueuedAt">): Waiter => ({
  project: "p",
  alias: "a",
  cls: "ux",
  candidates: ["e1"],
  ...over,
});

test("pickNext: higher wait*speed wins over earlier arrival", () => {
  const ux = [w({ id: 1, speed: 1, enqueuedAt: 0 }), w({ id: 2, speed: 8, enqueuedAt: 100 })];
  const out = pickNext(ux, [], { e1: 1 }, 1000);
  // scores: 1*1000=1000 vs 8*900=7200 → id 2
  assert.equal(out[0].w.id, 2);
  assert.equal(ux.length, 1);
});

test("pickNext: equal score → FIFO (earlier enqueuedAt)", () => {
  const ux = [w({ id: 1, speed: 2, enqueuedAt: 100 }), w({ id: 2, speed: 2, enqueuedAt: 200 })];
  // force equal scores at now=600: 2*500 vs 2*400 — not equal; use same enqueuedAt
  ux[1].enqueuedAt = 100;
  const out = pickNext(ux, [], { e1: 1 }, 600);
  assert.equal(out[0].w.id, 1);
});

test("pickNext: speed 0 only dispatches when no speed>=1 waiter exists", () => {
  const ux = [w({ id: 1, speed: 0, enqueuedAt: 0 }), w({ id: 2, speed: 1, enqueuedAt: 10 })];
  let out = pickNext(ux, [], { e1: 1 }, 1000);
  assert.equal(out[0].w.id, 2); // speed 1 beats ancient speed 0
  out = pickNext(ux, [], { e1: 1 }, 1000);
  assert.equal(out[0].w.id, 1); // now alone → dispatches
});

test("pickNext: speed 0 in UX queue waits for speed>=1 in NON-UX queue", () => {
  const ux = [w({ id: 1, speed: 0, enqueuedAt: 0 })];
  const nonUx = [w({ id: 2, speed: 1, enqueuedAt: 5, cls: "non-ux" })];
  const out = pickNext(ux, nonUx, { e1: 1 }, 1000);
  assert.equal(out.length, 1);
  assert.equal(out[0].w.id, 2);
});

test("pickNext: UX queue drains before non-UX on the same slot", () => {
  const ux = [w({ id: 1, speed: 1, enqueuedAt: 100 })];
  const nonUx = [w({ id: 2, speed: 8, enqueuedAt: 0, cls: "non-ux" })];
  const out = pickNext(ux, nonUx, { e1: 1 }, 1000);
  assert.equal(out[0].w.id, 1); // UX priority beats a higher non-UX score
});

test("pickNext: failover to next candidate with availability", () => {
  const ux = [w({ id: 1, speed: 1, enqueuedAt: 0, candidates: ["e1", "e2"] })];
  const out = pickNext(ux, [], { e1: 0, e2: 1 }, 1000);
  assert.equal(out[0].ep, "e2");
});

test("pickNext: ladder order preferred when both have room", () => {
  const ux = [w({ id: 1, speed: 1, enqueuedAt: 0, candidates: ["e1", "e2"] })];
  const out = pickNext(ux, [], { e1: 1, e2: 1 }, 1000);
  assert.equal(out[0].ep, "e1");
});

test("pickNext: multiple slots dispatch multiple waiters in one pass", () => {
  const ux = [
    w({ id: 1, speed: 1, enqueuedAt: 0 }),
    w({ id: 2, speed: 1, enqueuedAt: 1 }),
  ];
  const out = pickNext(ux, [], { e1: 2 }, 1000);
  assert.deepEqual(out.map((o) => o.w.id), [1, 2]); // FIFO at equal speed
  assert.equal(ux.length, 0);
});

test("pickNext: waiter whose candidates are all unavailable is skipped", () => {
  const ux = [w({ id: 1, speed: 9, enqueuedAt: 0, candidates: ["e2"] })];
  const out = pickNext(ux, [], { e1: 1, e2: 0 }, 1000);
  assert.equal(out.length, 0);
});

// ---------- allDown / rejectAllDown / sweepAllDown ----------

import { Switchboard } from "./server.ts";

function fakeRes() {
  const out: { status?: number; body?: string } = {};
  return {
    out,
    res: {
      headersSent: false,
      writeHead(status: number) {
        out.status = status;
      },
      end(body?: string) {
        out.body = body;
      },
    },
  };
}

function fakeReq(sb: Switchboard, over: Partial<{ project: string; alias: string; candidates: string[]; cls: "ux" | "non-ux" }> = {}) {
  const { res, out } = fakeRes();
  const r = {
    id: sb.id(),
    req: { socket: undefined } as never,
    res: res as never,
    path: "/v1/chat/completions",
    body: Buffer.from("{}"),
    user: "t",
    cls: over.cls ?? ("ux" as const),
    project: over.project ?? "default",
    alias: over.alias ?? "easy",
    candidates: over.candidates ?? ["e1", "e2"],
    enqueuedAt: 0,
    speed: 1,
    retries: 0,
    out,
  };
  return r;
}

test("allDown: false while any candidate healthy; true when all breakered", () => {
  const sb = new Switchboard(cfg, () => {});
  const r = fakeReq(sb);
  // nothing probed yet — all probeOk=false → all down
  assert.equal(sb.allDown(r), true);
  sb.eps.get("e1")!.probeOk = true;
  assert.equal(sb.allDown(r), false);
  sb.tripBreaker("e1");
  assert.equal(sb.allDown(r), true);
});

test("sweepAllDown: 503s queued waiters whose candidates all broke, spares others", () => {
  const sb = new Switchboard(cfg, () => {});
  sb.eps.get("e1")!.probeOk = true;
  sb.eps.get("e2")!.probeOk = true;
  sb.eps.get("eclaude")!.probeOk = true;
  const doomed = fakeReq(sb); // candidates e1,e2
  const spared = fakeReq(sb, { candidates: ["eclaude"] }); // stays healthy
  sb.enqueue(doomed as never);
  sb.enqueue(spared as never);
  sb.tripBreaker("e2"); // spared still has e1
  assert.equal(sb.size, 2);
  sb.tripBreaker("e1"); // doomed now has none
  assert.equal(sb.size, 1);
  assert.equal(doomed.out.status, 503);
  assert.ok(doomed.out.body!.includes("all endpoints down for default/easy"));
  assert.equal(spared.out.status, undefined);
});

test("rejectAllDown: removes from queue and detaches socket listener", () => {
  const sb = new Switchboard(cfg, () => {});
  const r = fakeReq(sb);
  sb.enqueue(r as never);
  assert.equal(sb.size, 1);
  sb.rejectAllDown(r as never);
  assert.equal(sb.size, 0);
  assert.equal(r.offQ, undefined);
});

// ---------- buildAuditRecord ----------

const auditBase = {
  id: 7,
  user: "factory",
  cls: "non-ux" as const,
  project: "default",
  alias: "planning",
  ep: "eVeles",
  model: "unsloth/Qwen3.8-27B-GGUF",
  path: "/v1/chat/completions",
  status: 200,
  enqueuedAt: 1_000,
  dispatchedAt: 1_500,
  now: 2_500,
};

test("buildAuditRecord: shallow logs metadata, never the prompt", () => {
  const body = Buffer.from(
    JSON.stringify({ model: "planning", max_tokens: 4096, messages: [{ role: "user", content: "secret-prompt-body" }] }),
  );
  const rec = buildAuditRecord({ ...auditBase, body, deep: false });
  assert.equal(rec.user, "factory");
  assert.equal(rec.cls, "non-ux");
  assert.equal(rec.alias, "planning");
  assert.equal(rec.ep, "eVeles");
  assert.equal(rec.status, 200);
  assert.equal(rec.wait_ms, 500); // dispatchedAt - enqueuedAt
  assert.equal(rec.run_ms, 1000); // now - dispatchedAt
  assert.equal(rec.n_msgs, 1);
  assert.equal(rec.max_tokens, 4096);
  assert.ok((rec.prompt_chars as number) > 0);
  assert.equal("prompt" in rec, false); // shallow must not leak content
  assert.ok(!JSON.stringify(rec).includes("secret-prompt-body"));
});

test("buildAuditRecord: deep includes prompt and flags truncation", () => {
  const big = "x".repeat(20_000);
  const body = Buffer.from(
    JSON.stringify({ messages: [{ role: "user", content: big }] }),
  );
  const rec = buildAuditRecord({ ...auditBase, body, deep: true });
  assert.ok(typeof rec.prompt === "string");
  assert.equal((rec.prompt as string).length, 8_000); // DEEP_CAP
  assert.equal(rec.truncated, true);
});

test("buildAuditRecord: non-JSON body yields zeroed metadata, no throw", () => {
  const rec = buildAuditRecord({ ...auditBase, body: Buffer.from("not json"), deep: true });
  assert.equal(rec.n_msgs, 0);
  assert.equal(rec.prompt_chars, 0);
  assert.equal(rec.max_tokens, undefined);
  assert.equal("prompt" in rec, false);
});

// ---------- cache affinity ----------

test("chooseEp: home endpoint preferred over ladder order", () => {
  const home = new Map([["k1", "e2"]]);
  assert.equal(chooseEp(["e1", "e2"], (e) => true, "k1", home), "e2");
});

test("chooseEp: home busy → ladder fallback and home follows the landing", () => {
  const home = new Map([["k1", "e2"]]);
  const ep = chooseEp(["e1", "e2"], (e) => e === "e1", "k1", home);
  assert.equal(ep, "e1");
  assert.equal(home.get("k1"), "e1");
});

test("chooseEp: no key or unknown home → plain ladder order", () => {
  const home = new Map([["k9", "e9"]]);
  assert.equal(chooseEp(["e1", "e2"], (e) => true, undefined, home), "e1");
  assert.equal(chooseEp(["e1", "e2"], (e) => true, "k1", home), "e1");
});

test("pickNext: affinity steers endpoint without changing waiter order", () => {
  const ux = [
    w({ id: 1, speed: 1, enqueuedAt: 0, candidates: ["e1", "e2"], affinityKey: "k1" }),
  ];
  const home = new Map([["k1", "e2"]]);
  const out = pickNext(ux, [], { e1: 1, e2: 1 }, 1000, home);
  assert.equal(out[0].ep, "e2");
});

test("setHome: evicts oldest beyond cap", () => {
  const h = new Map<string, string>();
  for (let i = 0; i < HOME_CAP + 10; i++) setHome(h, `k${i}`, "e1");
  assert.equal(h.size, HOME_CAP);
  assert.equal(h.has("k0"), false);
  assert.equal(h.has(`k${HOME_CAP + 9}`), true);
});

test("affinityKeyFromBody: stable across turns, undefined for non-chat", () => {
  const turn1 = Buffer.from(
    JSON.stringify({ model: "m", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] }),
  );
  const turn2 = Buffer.from(
    JSON.stringify({
      model: "m",
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
        { role: "user", content: "more" },
      ],
    }),
  );
  const k1 = affinityKeyFromBody(turn1);
  assert.ok(k1);
  assert.equal(affinityKeyFromBody(turn2), k1);
  assert.equal(affinityKeyFromBody(Buffer.from(JSON.stringify({ model: "m", prompt: "x" }))), undefined);
  assert.equal(affinityKeyFromBody(Buffer.from("not json")), undefined);
});

// ---------- passthrough: external identities + combo addressing ----------

const pcfg: SwitchboardCfg = {
  ...cfg,
  endpoints: {
    ...cfg.endpoints,
    e9: { url: "http://r:20128", model: "Driver", authPassthrough: true },
  },
  aliases: { ...cfg.aliases, pool: ["e9"], mixed: ["e1", "e9"] },
  projects: {
    ...cfg.projects,
    default: { speed: 1, mask: [...cfg.projects.default.mask, "pool", "mixed"] },
  },
};

test("parseModel: external key filters to passthrough endpoints only", () => {
  const r = parseModel("default/mixed", pcfg, "ux", true);
  assert.deepEqual(r, { project: "default", alias: "mixed", candidates: ["e9"] });
});

test("parseModel: external key on non-passthrough alias → descriptive error", () => {
  const r = parseModel("default/easy", pcfg, "ux", true);
  assert.ok("error" in r && r.error.includes("passthrough"));
});

test("parseModel: combo suffix pool/Worker resolves with upstreamModel", () => {
  const r = parseModel("default/pool/Worker", pcfg, "ux");
  assert.deepEqual(r, {
    project: "default",
    alias: "pool",
    candidates: ["e9"],
    upstreamModel: "Worker",
  });
});

test("parseModel: combo suffix rejected when base alias has non-passthrough eps", () => {
  const r = parseModel("default/easy/M1", pcfg, "ux");
  assert.ok("error" in r && r.error.includes("unknown alias"));
});
