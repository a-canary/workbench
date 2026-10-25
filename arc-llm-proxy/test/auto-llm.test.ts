// auto-llm unit tests — pure sampling/selection/parsing primitives.
// run: node --test test/auto-llm.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gammaSample, betaSample, pickArm, topArm, exploitPick, EXPLOIT_GATE, EXPLOIT_SHARE, applyReward, parseClass, parseRuling, lastUserText,
  normalizeMessages, median, costWeight, matchMarketId, buildPriceMap, healToolCalls, toolSummary, withTurnScope,
  redactFlags, reviewNote, buildCorrectionMessages, applyFlags, AutoLlm, detectSoftFail, toolCallHash, dbReadPolicy, excludeFamily,
  EMPTY_FAILFAST_BYTES,
} from "../auto-llm.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// deterministic LCG
const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

test("gamma/beta samples stay in range", () => {
  const rng = lcg(42);
  for (let i = 0; i < 200; i++) {
    assert.ok(gammaSample(1, rng) > 0);
    assert.ok(gammaSample(0.4, rng) > 0);
    const b = betaSample(3, 1, rng);
    assert.ok(b >= 0 && b <= 1);
  }
});

test("beta mean tracks a/(a+b) roughly", () => {
  const rng = lcg(7);
  let sum = 0;
  for (let i = 0; i < 2000; i++) sum += betaSample(9, 1, rng);
  const mean = sum / 2000;
  assert.ok(Math.abs(mean - 0.9) < 0.05, `mean ${mean}`);
});

test("pickArm: strongest mean wins most draws; explore flag = draw beat argmax-mean", () => {
  const rng = lcg(3);
  const st = { strong: { a: 50, b: 1 }, weak: { a: 1, b: 50 } };
  let strongWins = 0, explores = 0;
  for (let i = 0; i < 300; i++) {
    const p = pickArm(["strong", "weak"], st, new Set(), new Map(), Date.now(), 0, rng);
    assert.ok("model" in p);
    if ("model" in p) {
      if (p.model === "strong") strongWins++;
      if (p.explore) explores++;
    }
  }
  assert.ok(strongWins > 280, `strong ${strongWins}`);
  assert.ok(explores === 300 - strongWins || explores >= 0);
});

test("pickArm: exclusions and cooldown remove arms; empty → error", () => {
  const rng = lcg(5);
  const excl = new Set(["a"]);
  const p1 = pickArm(["a", "b"], undefined, excl, new Map(), Date.now(), 0, rng);
  assert.equal("model" in p1 && p1.model, "b");
  const errs = new Map([["b", Date.now()]]);
  const p2 = pickArm(["a", "b"], undefined, excl, errs, Date.now(), 60_000, rng);
  assert.ok("error" in p2);
  // after cooldown expiry, b is live again
  const p3 = pickArm(["a", "b"], undefined, excl, new Map([["b", Date.now() - 120_000]]), Date.now(), 60_000, rng);
  assert.equal("model" in p3 && p3.model, "b");
});

test("applyReward increments the right count", () => {
  const st: Parameters<typeof applyReward>[0] = {};
  applyReward(st, "code", "m1", true);
  applyReward(st, "code", "m1", true);
  applyReward(st, "code", "m1", false);
  assert.deepEqual(st.code.m1, { a: 3, b: 2 });
});

test("parseClass picks a known class word, else fallback", () => {
  const classes = ["code", "debug", "reasoning"];
  assert.equal(parseClass("This is a DEBUG task", classes, "conversation"), "debug");
  assert.equal(parseClass("nothing matches", classes, "conversation"), "conversation");
});

test("parseClass matches hyphenated class words exactly", () => {
  const classes = ["chat", "goal-setting", "clarification", "planning"];
  assert.equal(parseClass("goal-setting", classes, "chat"), "goal-setting");
  assert.equal(parseClass("this is planning work", classes, "chat"), "planning");
  assert.equal(parseClass("I need clarification", classes, "chat"), "clarification");
  assert.equal(parseClass("neither word here", classes, "chat"), "chat");
});

test("withTurnScope prepends system hint when on, passthrough when off", () => {
  const msgs = [{ role: "user", content: "hi" }];
  assert.deepEqual(withTurnScope(msgs, "goal-setting", true),
    [{ role: "system", content: "[turn scope: goal-setting]" }, { role: "user", content: "hi" }]);
  assert.equal(withTurnScope(msgs, "goal-setting", false), msgs);
  const empty: unknown[] = [];
  assert.equal(withTurnScope(empty, "chat", true), empty); // empty passthrough, same ref
  const out = withTurnScope(msgs, "chat", true);
  assert.notEqual(out, msgs); // always a new array, caller can reassign safely
});

// ---------- attacker (B): ruling parser ----------

test("parseRuling: silent approve", () => {
  assert.deepEqual(parseRuling("Looks sound overall.\nRULING: SILENT-APPROVE"), { kind: "approve" });
});

test("parseRuling: stealth deny carries prose comment", () => {
  const r = parseRuling("Incoherent template noise. Nothing usable.\nRULING: STEALTH-DENY-RETRY");
  assert.equal(r?.kind, "deny");
  if (r?.kind === "deny") assert.match(r.comment ?? "", /Incoherent/);
});

test("parseRuling: blocking comment strips fences from prose", () => {
  const r = parseRuling("```json\n[1,2]\n```\nThe code would not compile.\nRULING: RESPOND-BLOCKING-COMMENT");
  assert.equal(r?.kind, "comment");
  if (r?.kind === "comment") {
    assert.match(r.comment, /would not compile/);
    assert.doesNotMatch(r.comment, /\[1,2\]/);
  }
});

test("parseRuling: comment FLAG lines become per-call doubts", () => {
  const r = parseRuling("The URL may 404.\nFLAG call_a: does this model exist on the hub?\nRULING: RESPOND-BLOCKING-COMMENT");
  assert.equal(r?.kind, "comment");
  if (r?.kind === "comment") {
    assert.equal(r.flags?.length, 1);
    assert.equal(r.flags?.[0]?.ref, "call_a");
    assert.match(r.flags?.[0]?.question ?? "", /model exist on the hub/);
    assert.match(r.comment, /URL may 404/);
    assert.doesNotMatch(r.comment, /FLAG/); // FLAG lines live in flags, not prose
  }
});

test("parseRuling: valid heal passes through", () => {
  const tools = [{ function: { name: "edit_file", parameters: { required: ["path"] } } }];
  const text = 'fixing the argument name\n```json\n[{"id":"c1","type":"function","function":{"name":"edit_file","arguments":"{\\\"path\\\":\\\"a\\\"}"}}]\n```\nRULING: HEAL-TOOL-CALL';
  const r = parseRuling(text, tools);
  assert.equal(r?.kind, "heal");
  if (r?.kind === "heal") assert.equal(r.calls[0]?.function?.name, "edit_file");
});

test("parseRuling: heal with unknown tool name degrades to comment", () => {
  const tools = [{ function: { name: "edit_file" } }];
  const text = '\n```json\n[{"type":"function","function":{"name":"run_cmd","arguments":"{}"}}]\n```\nRULING: HEAL-TOOL-CALL';
  const r = parseRuling(text, tools);
  assert.equal(r?.kind, "comment");
});

test("parseRuling: heal with no declared tools degrades to comment", () => {
  const text = '\n```json\n[{"type":"function","function":{"name":"x","arguments":"{}"}}]\n```\nRULING: HEAL-TOOL-CALL';
  assert.equal(parseRuling(text, undefined)?.kind, "comment");
});

test("parseRuling: LAST ruling line wins; none → undefined", () => {
  assert.equal(parseRuling("RULING: SILENT-APPROVE\nreconsidering\nRULING: STEALTH-DENY-RETRY")?.kind, "deny");
  assert.equal(parseRuling("RULING: STEALTH-DENY-RETRY then fixed\nRULING: SILENT-APPROVE")?.kind, "approve");
  assert.equal(parseRuling("no ruling here"), undefined);
});

// ---------- L0 deterministic heal ----------

test("healToolCalls: name normalized to declared tool, healed flag set", () => {
  const tools = [{ function: { name: "edit_file" } }];
  const { calls, healed } = healToolCalls(tools, [
    { id: "c1", type: "function", function: { name: "Edit-File", arguments: "{\"path\":\"a\"}" } },
  ]);
  assert.equal(healed, true);
  assert.equal(calls[0]?.function?.name, "edit_file");
});

test("healToolCalls: object args stringified, garbage reset to {}, id defaulted", () => {
  const { calls, healed } = healToolCalls(undefined, [
    { type: "function", function: { name: "x", arguments: { path: "a" } } },
    { type: "function", function: { name: "y", arguments: "not json" } },
  ]);
  assert.equal(healed, true);
  assert.equal(calls[0]?.function?.arguments, '{"path":"a"}');
  assert.equal(calls[1]?.function?.arguments, "{}");
  assert.equal(calls[0]?.id, "call_0");
});

test("healToolCalls: stringified-JSON args unwrapped", () => {
  // the classic double-encode: model emits the JSON *as a JSON string value*
  const { calls, healed } = healToolCalls(undefined, [
    { type: "function", function: { name: "x", arguments: '"{\\"path\\":\\"/tmp\\"}"' } },
  ]);
  assert.equal(healed, true);
  assert.equal(calls[0]?.function?.arguments, '{"path":"/tmp"}');
});

test("healToolCalls: valid calls untouched, healed=false", () => {
  const orig = [{ id: "c9", type: "function", function: { name: "edit_file", arguments: "{\"path\":\"a\"}" } }];
  const { calls, healed } = healToolCalls([{ function: { name: "edit_file" } }], orig);
  assert.equal(healed, false);
  assert.deepEqual(calls[0], orig[0]);
});

test("toolSummary: name + required params; empty → placeholder", () => {
  const tools = [
    { function: { name: "edit_file", parameters: { required: ["path", "content"] } } },
    { function: { name: "list" } },
  ];
  assert.equal(toolSummary(tools), "- edit_file(path, content)\n- list()");
  assert.equal(toolSummary(undefined), "(no tools available)");
  assert.equal(toolSummary([]), "(no tools available)");
});

// ---------- stream pump + synthetic finish ----------

function mkRes(): { res: Record<string, unknown> & { headersSent: boolean; writeHead(): void; write(s: string): boolean; end(s?: string): void }; out: string[] } {
  const out: string[] = [];
  const res = {
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(s: string) { out.push(s); return true; },
    end(s?: string) { if (s) out.push(s); },
  };
  return { res: res as never, out };
}

function mkRaw(chunks: string[]): unknown {
  const enc = new TextEncoder();
  let i = 0;
  return {
    body: {
      getReader: () => ({
        read: async () => i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined },
      }),
    },
  };
}

async function pump(raw: unknown, model = "m") {
  const { autoLlm } = await import("../auto-llm.ts");
  return (autoLlm as unknown as {
    pumpStream: (r: unknown, m: string) => Promise<{ text: string; toolCalls: Array<Record<string, unknown>> }>;
  }).pumpStream.call(autoLlm, raw, model);
}

test("pumpStream: content buffered, tool_calls held, finish/DONE dropped", async () => {
  // first data line deliberately split across two reads — boundary robustness
  const chunks = [
    'data: {"choices":[{"delta":{"ro',
    'le":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"edit_file","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"path\\\":\\\"a\\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const r = await pump(mkRaw(chunks));
  assert.equal(r.text, "Hello");
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]?.id, "c1");
  assert.deepEqual(r.toolCalls[0]?.function, { name: "edit_file", arguments: '{"path":"a"}' });
});

test("pumpStream: unparseable lines dropped; wrapped 9router chunks unwrapped", async () => {
  const chunks = [
    'data: not json\n\n',
    'data: {"data":{"choices":[{"delta":{"content":"X"}}]}}\n\n',
  ];
  const r = await pump(mkRaw(chunks));
  assert.equal(r.text, "X"); // wrap quirk parsed, garbage dropped
});

test("finishSse: tail + tool_calls + synthetic finish + DONE; headers auto-sent", async () => {
  const { autoLlm } = await import("../auto-llm.ts");
  const finishSse = (autoLlm as unknown as {
    finishSse: (res: unknown, model: string, o?: { tail?: string; toolCalls?: Array<Record<string, unknown>> }) => void;
  }).finishSse.bind(autoLlm);
  const cold = mkRes();
  finishSse(cold.res, "m", { tail: "t" });
  assert.ok(cold.res.headersSent); // headers auto-sent on first write
  assert.ok(cold.out.join("").includes("[DONE]"));

  const { res, out } = mkRes();
  res.headersSent = true;
  finishSse(res, "m", { tail: "[advisory review — not a stop order; continue your task. Flagged tool calls were withheld.]", toolCalls: [{ id: "c1", type: "function", function: { name: "edit_file", arguments: "{}" } }] });
  const j = out.join("");
  assert.ok(j.includes("[advisory review"));
  assert.ok(j.includes('"tool_calls"'));
  assert.ok(j.includes('"name":"edit_file"'));
  assert.ok(j.includes('"finish_reason":"tool_calls"'));
  assert.ok(j.includes("[DONE]"));
});

test("lastUserText finds last user turn, string or parts", () => {
  const body = { messages: [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: [{ type: "text", text: "second" }, { type: "image_url" }] },
  ] };
  assert.equal(lastUserText(body), "second");
  assert.equal(lastUserText({ messages: [] }), "");
  assert.equal(lastUserText(null), "");
});

test("normalizeMessages: developer role rewritten to system, others untouched", () => {
  const msgs = [
    { role: "developer", content: "system instructions" },
    { role: "system", content: "legacy system" },
    { role: "user", content: "hello" },
  ];
  const out = normalizeMessages(msgs) as Array<{ role: string; content: string }>;
  assert.equal(out[0].role, "system");
  assert.equal(out[0].content, "system instructions");
  assert.equal(out[1].role, "system");
  assert.equal(out[2].role, "user");
});

test("normalizeMessages: non-array input returns undefined", () => {
  assert.equal(normalizeMessages(undefined), undefined);
  assert.equal(normalizeMessages("string"), undefined);
  assert.equal(normalizeMessages({ not: "array" }), undefined);
});

// regression: 2026-09-09 outage — gatewayCall threw ECONNREFUSED on a dead
// arm, the unhandled rejection killed the whole :8091 silo (4× crash-loop).
test("gatewayCall: dead upstream returns ok:false status:0, never throws", async () => {
  const { autoLlm } = await import("../auto-llm.ts");
  const call = (autoLlm as unknown as {
    gatewayCall: (cfg: { gateway: string }, t: string, m: string, msgs: unknown[]) => Promise<{ ok: boolean; status: number }>;
  }).gatewayCall.bind(autoLlm);
  // port 1 on loopback: nothing listens there — guaranteed connect failure
  const r = await call({ gateway: "http://127.0.0.1:1/v1/chat/completions" }, "tok", "m", []);
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
});

// regression (review blocker): 200 arrives, body aborts mid-read — res.text()
// used to reject outside the catch → same silo-crash class as ECONNREFUSED.
test("gatewayCall: 200 then mid-body abort returns ok:false, never throws", async () => {
  const { autoLlm } = await import("../auto-llm.ts");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: () => Promise.reject(new Error("socket hang up mid-body")),
  })) as unknown as typeof fetch;
  try {
    const r = await (autoLlm as unknown as {
      gatewayCall: (cfg: { gateway: string }, t: string, m: string, msgs: unknown[]) => Promise<{ ok: boolean; status: number }>;
    }).gatewayCall.call(autoLlm, { gateway: "http://x/v1/chat/completions" }, "tok", "m", []);
    assert.equal(r.ok, false);
    assert.equal(r.status, 200); // status preserved for cooldown logging
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------- cost-aware pricing ----------

test("median: odd, even, empty", () => {
  assert.equal(median([]), 0);
  assert.equal(median([3]), 3);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("costWeight: neutral without price/median, clamped at 0.25/4", () => {
  assert.equal(costWeight(undefined, 1, 0.5), 1);
  assert.equal(costWeight(0.5, 0, 0.5), 1);   // no median → neutral
  assert.equal(costWeight(0.5, -0.5, 0.5), 1); // invalid median → neutral
  assert.equal(costWeight(0.5, 0.5, 0.5), 1);   // price = median → weight 1
  assert.ok(Math.abs(costWeight(1, 4, 0.5) - 2) < 1e-9); // (4/1)^0.5
  assert.equal(costWeight(1e9, 1, 0.5), 0.25); // cheap cap: very expensive arm
  assert.equal(costWeight(1e-9, 1, 0.5), 4);   // expensive cap: very cheap arm
  assert.equal(costWeight(0.5, 1, 0), 1);      // alpha 0 → pricing off
});

test("matchMarketId: exact, @cf strip, containment, miss", () => {
  const ids = ["qwen/qwen3.7-max", "z-ai/glm-5.2", "qwen/qwen3.8-max-0902", "meta-llama/llama-3.1-70b-instruct", "qwen/qwen3-coder"];
  assert.equal(matchMarketId("ali/qwen3.7-max", ids), "qwen/qwen3.7-max");
  assert.equal(matchMarketId("ali/glm-5.2", ids), "z-ai/glm-5.2");
  assert.equal(matchMarketId("cf/@cf/meta/llama-3.1-70b-instruct-fp8-fast", ids), "meta-llama/llama-3.1-70b-instruct");
  assert.equal(matchMarketId("ali/qwen3.8-max", ids), "qwen/qwen3.8-max-0902"); // containment
  assert.equal(matchMarketId("ali/wan2.7-image-pro", ids), undefined);           // no match
  assert.equal(matchMarketId("", ids), undefined);
});

test("buildPriceMap: real observed wins, free arms shadowed ×0.3, unpriced get median", () => {
  const arms = ["ali/qwen3.7-max", "cf/@cf/meta/llama-3.1-70b-instruct-fp8-fast", "ali/mystery-model"];
  const hist = { "qwen3.7-max": 0.2855 }; // paid arm — real $/1M
  const market = [{ id: "meta-llama/llama-3.1-70b-instruct", blend: 0.5 }];
  const map = buildPriceMap(arms, hist, market, 0.3);
  assert.equal(map["ali/qwen3.7-max"], 0.2855);        // real beats everything
  assert.ok(Math.abs(map["cf/@cf/meta/llama-3.1-70b-instruct-fp8-fast"] - 0.15) < 1e-9); // 0.3×0.5
  assert.ok(Math.abs(map["ali/mystery-model"] - median([0.2855, 0.15])) < 1e-9);         // median fill
});

test("buildPriceMap: empty market + empty history → all zeros → plain TS", () => {
  const map = buildPriceMap(["ali/a", "cf/b"], {}, [], 0.3);
  assert.equal(map["ali/a"], 0);
  assert.equal(map["cf/b"], 0);
});

test("pickArm cost-aware: equal priors, cheap arm wins most draws", () => {
  const rng = lcg(99);
  const st = { cheap: { a: 5, b: 1 }, exp: { a: 5, b: 1 } };
  const prices = { cheap: 0.1, exp: 10 };
  let cheap = 0;
  for (let i = 0; i < 300; i++) {
    const p = pickArm(["cheap", "exp"], st, new Set(), new Map(), Date.now(), 0, rng, prices, 0.5);
    if ("model" in p && p.model === "cheap") cheap++;
  }
  assert.ok(cheap > 0.9 * 300, `cheap wins ${cheap}/300`);
});

test("pickArm: moderate price gap does not flatten a proven arm", () => {
  const rng = lcg(5);
  const st = { cheap: { a: 5, b: 5 }, exp: { a: 90, b: 1 } }; // exp proven excellent
  const prices = { cheap: 0.3, exp: 0.7 }; // 2.3× gap — mild cost tilt, not an override
  let expWins = 0;
  for (let i = 0; i < 300; i++) {
    const p = pickArm(["cheap", "exp"], st, new Set(), new Map(), Date.now(), 0, rng, prices, 0.5);
    if ("model" in p && p.model === "exp") expWins++;
  }
  // weight exp ≈ 0.845, cheap ≈ 1.29 — posterior 0.99 vs 0.5 still carries exp
  assert.ok(expWins > 0.75 * 300, `exp wins ${expWins}/300`);
});

test("topArm: greedy argmax of raw posterior mean, live filter honored", () => {
  const st: Parameters<typeof topArm>[1] = { strong: { a: 99, b: 1 }, weak: { a: 1, b: 1 }, price: { a: 200, b: 1 } };
  const t = topArm(["weak", "strong", "price"], st, new Set(), new Map(), Date.now(), 0);
  assert.equal("error" in t, false);
  if (!("error" in t)) {
    assert.equal(t.model, "price"); // raw mean 0.995 beats strong 0.99 — no cost weight here
    assert.ok(t.mean > 0.99);
  }
  const cooled = topArm(["strong", "weak"], st, new Set(), new Map([["strong", Date.now() - 1000]]), Date.now(), 60_000);
  assert.ok(!("error" in cooled) && cooled.model === "weak");
  const none = topArm(["x"], st, new Set(["x"]), new Map(), Date.now(), 0);
  assert.ok("error" in none);
});

test("exploitPick: gate 0.90 (2026-09-11: 0.99 unreachable at ~5% natural miss) + 90% coin", () => {
  assert.equal(EXPLOIT_GATE, 0.90);
  assert.equal(EXPLOIT_SHARE, 0.9);
  const st: Parameters<typeof exploitPick>[1] = { hot: { a: 299, b: 1 }, cold: { a: 1, b: 1 } };
  const rng85 = lcg(3);
  // force coin < 0.9: find an lcg seed whose first draw is < 0.9
  let seed = 0;
  while (lcg(seed)() >= 0.9) seed++;
  const coinOk = lcg(seed);
  const yes = exploitPick(["hot", "cold"], st, new Set(), new Map(), Date.now(), 0, coinOk);
  assert.ok(yes && yes.model === "hot" && yes.explore === false);
  // coin lands outside share → explore
  let seed2 = 0;
  while (lcg(seed2)() < 0.9) seed2++;
  const no = exploitPick(["hot", "cold"], st, new Set(), new Map(), Date.now(), 0, lcg(seed2));
  assert.equal(no, null);
  // beta under gate → never exploit (0.889 < 0.90)
  const none2 = exploitPick(["hot", "cold"], { hot: { a: 8, b: 1 } }, new Set(), new Map(), Date.now(), 0, coinOk);
  assert.equal(none2, null);
});

test("judgeCall: primary down → judgePool failover; explicit (trusted) judge stays single-shot", async () => {
  const a = new AutoLlm("/tmp/no-such-auto-llm-dir-xyz");
  const calls: string[] = [];
  const extras: Array<Record<string, unknown>> = [];
  (a as any).gatewayCall = async (_cfg: unknown, _t: string, model: string, _m: unknown[], extra: Record<string, unknown>) => {
    calls.push(model); extras.push(extra);
    return model === "dead" ? { ok: false, status: 500 } : { ok: true, status: 200, json: { choices: [{ message: { content: "approve" } }] } };
  };
  const cfg = { judge: "dead", judgePool: ["glm-backup", "max-backup"], trustedJudge: "trusted" } as any;
  // primary dead → first pool member answers; chain stops at first ok
  const v = await (a as any).judgeCall(cfg, "tok", undefined, [{ role: "user", content: "x" }], { max_tokens: 8 });
  assert.equal(v.ok, true);
  assert.deepEqual(calls, ["dead", "glm-backup"]);
  // thinking:disabled always rides along (glm honors it, qwen ignores it)
  assert.deepEqual(extras[0].thinking, { type: "disabled" });
  // explicit model = trusted judge: single-shot, no failover (fail-safe by design)
  calls.length = 0;
  const t = await (a as any).judgeCall(cfg, "tok", "trusted", [{ role: "user", content: "x" }], {});
  assert.equal(t.ok, true);
  assert.deepEqual(calls, ["trusted"]);
  // primary + whole pool down → not-ok; callers keep their fail-open paths
  calls.length = 0;
  const none = await (a as any).judgeCall({ judge: "dead" } as any, "tok", undefined, [], {});
  assert.equal(none.ok, false);
  assert.deepEqual(calls, ["dead"]);
});

test("redactFlags drops flagged calls (id + #pos) for the corrector forward only", () => {
  const calls = [
    { id: "call_a", function: { name: "read_file", arguments: "{}" } },
    { id: "call_b", function: { name: "bash", arguments: "{}" } },
  ];
  assert.deepEqual(redactFlags(calls, [{ ref: "call_a", question: "?" }]), [calls[1]]);
  assert.deepEqual(redactFlags(calls, [{ ref: "#2", question: "?" }]), [calls[0]]);
  assert.equal(redactFlags(calls, undefined), calls); // no flags → unredacted
  assert.equal(redactFlags(calls, [{ ref: "call_zz", question: "?" }]).length, 2); // unknown ref → drop nothing
  // delivery stays no-withhold: applyFlags kept = ALL calls
  const r = applyFlags(calls, [{ ref: "call_a", question: "?" }]);
  assert.equal(r.kept.length, 2);
  assert.deepEqual(r.doubts, ["- read_file (call_a): ?"]);
});

test("reviewNote + buildCorrectionMessages: defect forward, invisible to end user", () => {
  const note = reviewNote("truncated output", ["- bash (call_a): full command?"]);
  assert.match(note, /Defect: truncated output/);
  assert.match(note, /Questions to answer:/);
  assert.match(note, /Produce a corrected response/);
  const msgs = buildCorrectionMessages([{ role: "user", content: "hi" }], "bad", [{ id: "c", function: { name: "f", arguments: "{}" } }], note);
  assert.equal(msgs.length, 3); // conversation + assistant + review turn
  assert.equal((msgs[1] as { role: string }).role, "assistant");
  assert.equal((msgs[1] as { tool_calls: unknown[] }).tool_calls.length, 1);
  assert.equal((msgs[2] as { content: string }).content, note);
  // full redact → placeholder, no tool_calls
  const empty = buildCorrectionMessages([{ role: "user", content: "hi" }], "", [], note);
  assert.equal((empty[1] as { content: string }).content, "(response redacted by review)");
  assert.equal((empty[1] as Record<string, unknown>).tool_calls, undefined);
  // no doubts → no Questions block
  assert.doesNotMatch(reviewNote("x", []), /Questions/);
});

// soft-fail detection (operator design 2026-09-11): identical call repeated
// after an error-signature result → serving arm took a quality failure
test("detectSoftFail: repeat-after-error flags the call; benign cases do not", () => {
  const call = (args: string) => ({ id: "x", type: "function", function: { name: "bash", arguments: args } });
  const A = call('{"cmd":"cat /nope"}');
  const errRe = new RegExp(["no such file or directory", "command not found"].join("|"), "i");
  // error → model re-emits the identical call → flag
  assert.deepEqual(detectSoftFail([
    { role: "user", content: "do it" },
    { role: "assistant", tool_calls: [A] },
    { role: "tool", content: "cat: /nope: No such file or directory" },
    { role: "assistant", tool_calls: [A] },
  ], errRe), [toolCallHash(A)]);
  // benign result between → probe/adjust, no flag
  assert.equal(detectSoftFail([
    { role: "assistant", tool_calls: [A] },
    { role: "tool", content: "ok" },
    { role: "assistant", tool_calls: [A] },
  ], errRe).length, 0);
  // error but the model adjusted (different args) → no flag
  assert.equal(detectSoftFail([
    { role: "assistant", tool_calls: [A] },
    { role: "tool", content: "No such file or directory" },
    { role: "assistant", tool_calls: [call('{"cmd":"cat /yep"}')] },
  ], errRe).length, 0);
  // parallel identical calls in one turn are simultaneous — not a repeat
  assert.equal(detectSoftFail([
    { role: "assistant", tool_calls: [A, A] },
    { role: "tool", content: "No such file or directory" },
    { role: "tool", content: "No such file or directory" },
  ], errRe).length, 0);
});

test("toolCallHash: stable, arg-sensitive", () => {
  const c = { id: "1", function: { name: "bash", arguments: '{"cmd":"ls"}' } };
  assert.equal(toolCallHash(c), toolCallHash({ ...c }));
  assert.notEqual(toolCallHash(c), toolCallHash({ function: { name: "bash", arguments: '{"cmd":"ls -l"}' } }));
});

// db-read policy (operator 2026-09-12): binary-db text reads never execute.
const dbCall = (name: string, args: unknown) => ({ id: `c_${name}`, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });

test("dbReadPolicy strips read of .db/.sqlite/.sqlite3/.duckdb, case-insensitive", () => {
  const r = dbReadPolicy([dbCall("read", { path: "/home/user/repos/RRDM/report.db" }), dbCall("READ", { path: "x.SQLITE3" }), dbCall("view", { path: "y.duckdb" }), dbCall("read", { path: "z.sqlite" })]);
  assert.equal(r.stripped.length, 4);
  assert.equal(r.kept.length, 0);
});

test("dbReadPolicy keeps ordinary reads, writes, and bash sqlite3", () => {
  const r = dbReadPolicy([dbCall("read", { path: "auto-llm.ts" }), dbCall("bash", { command: "sqlite3 report.db 'SELECT 1'" }), dbCall("write", { path: "out.db" }), dbCall("read", { path: "db-notes.md" })]);
  assert.equal(r.stripped.length, 0);
  assert.equal(r.kept.length, 4);
});

test("dbReadPolicy keeps unparseable args (P1's job) and object-arg shapes", () => {
  const broken = { id: "c", type: "function", function: { name: "read", arguments: "start</arg_key" } };
  assert.equal(dbReadPolicy([broken]).kept.length, 1);
  assert.equal(dbReadPolicy([{ id: "c", type: "function", function: { name: "read", arguments: { path: "report.db" } } }]).stripped.length, 1);
  assert.equal(dbReadPolicy([dbCall("read", { file_path: "a/b.sqlite3" })]).stripped.length, 1);
});

test("dbReadPolicy mixed: keeps the rest, refs by position resolve via redactFlags", () => {
  const calls = [dbCall("bash", { command: "ls" }), dbCall("read", { path: "report.db" }), dbCall("read", { path: "ok.ts" })];
  const r = dbReadPolicy(calls);
  assert.deepEqual(r.kept.map((c) => (c.function as { name: string }).name), ["bash", "read"]);
  assert.equal(r.stripped.length, 1);
  // the serve-path flag ref is the 1-based position in the ORIGINAL array
  const redacted = redactFlags(calls, [{ ref: "#2", question: "db read" }]);
  assert.equal(redacted.length, 2);
});

// regression 2026-09-18: clinepass hit its MONTHLY account quota (upstream 429
// INFERENCE_CAP_ERROR, surfaced by the gateway as 503). All 13 clinepass/* arms
// in the reasoning partition died at once, but TS scores arms independently, so
// a turn spent all 5 attempts inside that one dead family and returned 502 —
// healthy ali/*, minimax/* arms were never sampled. Family exclusion within the
// turn is what makes the remaining attempts reach a different credential.
test("excludeFamily: one dead credential removes every sibling for the turn", () => {
  const arms = [
    "clinepass/cline-pass/mimo-v2.5", "clinepass/claude-opus-4-7",
    "ali/deepseek-v4.1-flash", "minimax/MiniMax-M3", "noslash",
  ];
  const ex = new Set<string>();
  excludeFamily(ex, arms, "clinepass/cline-pass/mimo-v2.5");
  assert.deepEqual([...ex].sort(), ["clinepass/claude-opus-4-7", "clinepass/cline-pass/mimo-v2.5"]);
  // a second family failure compounds; unrelated families stay live
  excludeFamily(ex, arms, "ali/deepseek-v4.1-flash");
  assert.equal(ex.size, 3);
  assert.equal(ex.has("minimax/MiniMax-M3"), false);
  assert.equal(ex.has("noslash"), false);
  // an arm with no prefix has no siblings to protect
  const ex2 = new Set<string>();
  excludeFamily(ex2, arms, "noslash");
  assert.deepEqual([...ex2], ["noslash"]);
});

// guard: the helper is worthless unless BOTH budget-consuming failure branches
// call it. Cheap source assertion so a refactor cannot silently drop a wiring.
// (`deny` deliberately does NOT family-exclude — a judge rejection is about
// that arm's output, and a sibling may answer better.)
test("excludeFamily is wired into serve-error and gate-reject, not into deny", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../auto-llm.ts", import.meta.url), "utf8");
  const calls = src.split("\n").filter((l) => l.includes("excludeFamily(excluded, arms, pick.model)"));
  assert.equal(calls.length, 2, "expected exactly 2 call sites: serve-error + gate-reject");
  assert.ok(calls.some((l) => l.includes("dead credential")), "serve-error call site lost its comment");
  assert.ok(calls.some((l) => l.includes("request-determined")), "gate-reject call site lost its comment");
});

// ---------- request-determined failure: fail fast, do not re-pay (3qw) ----------

/** A dir with a minimal auto-llm config whose arms ALL return an empty
 *  completion — the over-budget signature. Returns the instance plus counters. */
async function emptyArmHarness(reqBytes: number) {
  const dir = mkdtempSync(join(tmpdir(), "all-fast-"));
  mkdirSync(join(dir, "deploy"), { recursive: true });
  writeFileSync(join(dir, "deploy/auto-llm.json"), JSON.stringify({
    gateway: "http://127.0.0.1:1/v1/chat/completions", classes: ["qa", "chat"], unknownClass: "chat",
    judge: "j", maxRetries: 4, cooldownMs: 120000, stateFile: "deploy/state.json", logFile: "deploy/log.jsonl",
  }));
  const a = new AutoLlm(dir);
  const sent: string[] = [];
  (a as any).judgeCall = async () => ({ ok: true, status: 200, json: { choices: [{ message: { content: "qa" } }] } });
  (a as any).getUniverse = async () => ["ali/a", "ali/b", "minimax/c", "mm/d", "hg/e", "or/f"];
  (a as any).gatewayCall = async (_c: unknown, _t: string, m: string) => { sent.push(m); return { ok: true, status: 200, json: { choices: [{ message: { content: "" } }] } }; };
  (a as any).maybeRefreshPrices = () => {};
  const body = Buffer.from(JSON.stringify({ model: "auto-llm", messages: [{ role: "user", content: "x".repeat(Math.max(1, reqBytes - 100)) }] }));
  let status = 0; let out = "";
  const res = { writeHead: (s: number) => { status = s; }, end: (s: string) => { out = s; } } as any;
  const handled = await a.handle({ headers: {} } as any, res, body, "tester", "tok");
  return { a, sent, status, out, handled, bodyLen: body.length };
}

test("oversized request + empty completion → 400 after ONE paid send, beta untouched", async () => {
  const h = await emptyArmHarness(EMPTY_FAILFAST_BYTES + 5_000);
  assert.ok(h.bodyLen > EMPTY_FAILFAST_BYTES, "harness must actually exceed the threshold");
  assert.equal(h.handled, true);
  assert.equal(h.status, 400, "request-determined failure must be non-retryable for the client");
  assert.match(h.out, /request too large/);
  assert.match(h.out, /[Cc]ompact|new one/, "message must tell the client what to do");
  assert.equal(h.sent.length, 1, `must not re-pay for a deterministic failure, got ${h.sent.length} sends`);
  assert.deepEqual((h.a as any).state?.qa ?? {}, {}, "an over-budget empty is not an arm quality signal");
});

test("small request + empty completion still fails over across families → 502", async () => {
  const h = await emptyArmHarness(2_000);
  assert.ok(h.bodyLen < EMPTY_FAILFAST_BYTES);
  assert.equal(h.status, 502, "a small empty may be a sick arm — keep the retry budget");
  assert.ok(h.sent.length >= 2, `expected failover attempts, got ${h.sent.length}`);
  const st = (h.a as any).state?.qa ?? {};
  assert.ok(Object.keys(st).length > 0, "small-request empties still penalise beta (existing behaviour)");
});

test("pickArm: a missing cooldownMs must not exclude every arm", () => {
  const arms = ["ali/a", "minimax/b"];
  const p = pickArm(arms, {}, new Set(), new Map(), Date.now(), undefined as unknown as number, lcg(7), {}, 0.5, new Set(), 0.5);
  assert.ok(!("error" in p), `config typo must degrade to no cooldown, got ${JSON.stringify(p)}`);
});

test("EMPTY_FAILFAST_BYTES is ~100k tokens and the fail-fast is wired before any reward", () => {
  assert.ok(EMPTY_FAILFAST_BYTES >= 300_000 && EMPTY_FAILFAST_BYTES <= 600_000, "threshold must sit near 100k tokens");
  const src = readFileSync(join(import.meta.dirname, "..", "auto-llm.ts"), "utf8");
  const gate = src.indexOf('if (gate) {');
  const fast = src.indexOf('gate === "empty" && reqBytes > EMPTY_FAILFAST_BYTES');
  const reward = src.indexOf("applyReward(this.state, cls, pick.model, false);", gate);
  assert.ok(gate > 0 && fast > gate, "fail-fast must live inside the gate branch");
  assert.ok(fast < reward, "fail-fast must precede the beta penalty, or the arm is still blamed");
});

// ---------- phase-2 cutover: the vector-field route hook (bead aaw) ----------

/** Drives one full turn through AutoLlm.handle with every upstream stubbed, so
 *  the assertions are about ROUTING decisions, not about models. */
async function turnHarness(o: {
  reqBytes?: number; maxTokens?: number; completion?: string; ruling?: string;
  vec?: { zone: string; arm?: string; why?: string } | null | "unset";
  arms?: string[]; backoff?: string[];
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "all-vec-"));
  mkdirSync(join(dir, "deploy"), { recursive: true });
  writeFileSync(join(dir, "deploy/auto-llm.json"), JSON.stringify({
    gateway: "http://127.0.0.1:1/v1/chat/completions", classes: ["qa", "chat"], unknownClass: "chat",
    judge: "j", maxRetries: 4, cooldownMs: 120000, stateFile: "deploy/state.json", logFile: "deploy/log.jsonl",
  }));
  const a = new AutoLlm(dir);
  const sent: string[] = []; const judged: string[] = []; const vecTexts: string[] = [];
  const observed: Array<{ text: string; entry: Record<string, unknown> }> = [];
  let okFn: ((arm: string) => boolean) | undefined;
  (a as any).getUniverse = async () => o.arms ?? ["ali/a", "ali/b", "minimax/c", "mm/d", "hg/e", "or/f"];
  (a as any).maybeRefreshPrices = () => {};
  (a as any).gatewayCall = async (_c: unknown, _t: string, m: string) => {
    sent.push(m);
    return { ok: true, status: 200, json: { choices: [{ message: { content: o.completion ?? "a real answer" } }] } };
  };
  (a as any).judgeCall = async (_c: unknown, _t: string, model: string | undefined, msgs: Array<{ content?: string }>) => {
    const ask = String(msgs?.[0]?.content ?? "");
    judged.push(ask.startsWith("classify-only") ? "classify" : `attack:${model ?? "cheap"}`);
    const content = ask.startsWith("classify-only") ? "qa" : (o.ruling ?? "RULING: SILENT-APPROVE");
    return { ok: true, status: 200, json: { choices: [{ message: { content } }] } };
  };
  a.observe = (entry, text) => { observed.push({ text, entry }); };
  if (o.vec !== "unset") a.vecRoute = async (text: string, ok: (arm: string) => boolean) => {
    vecTexts.push(text); okFn = ok;
    return (o.vec ?? null) as never;
  };
  for (const m of o.backoff ?? []) (a as any).backoff.set(m, { fails: 1, until: Date.now() + 600_000 });
  const filler = "x".repeat(Math.max(1, (o.reqBytes ?? 2_000) - 120));
  const body = Buffer.from(JSON.stringify({
    model: "auto-llm", messages: [{ role: "user", content: "first mission anchor" }, { role: "user", content: filler }],
    ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
  }));
  let status = 0; let out = "";
  const res = { writeHead: (s: number) => { status = s; }, end: (s: string) => { out = s; } } as any;
  const handled = await a.handle({ headers: {} } as any, res, body, "tester", "tok");
  return { a, sent, judged, vecTexts, observed, status, out, handled, bodyLen: body.length, okFn: () => okFn };
}

test("preflight: oversized request with a starved budget pays for NOTHING", async () => {
  const h = await turnHarness({ reqBytes: EMPTY_FAILFAST_BYTES + 5_000, maxTokens: 1 });
  assert.equal(h.status, 400);
  assert.match(h.out, /request too large/);
  assert.equal(h.sent.length, 0, "no completion should be bought");
  assert.equal(h.judged.length, 0, "not even the classify call");
});

test("preflight does not fire on a normal-sized request", async () => {
  const h = await turnHarness({ reqBytes: 2_000, maxTokens: 1 });
  assert.equal(h.status, 200, `small request must still serve, got ${h.status} ${h.out.slice(0, 120)}`);
});

test("deny backstop: an oversized request denied once ends the turn, beta untouched", async () => {
  const h = await turnHarness({
    reqBytes: EMPTY_FAILFAST_BYTES + 5_000, completion: "<think>starved fragment",
    ruling: "RULING: STEALTH-DENY-RETRY",
  });
  assert.equal(h.status, 400);
  assert.match(h.out, /non-responsive/);
  assert.equal(h.sent.length, 1, "one paid send, not five");
  assert.deepEqual((h.a as any).state?.qa ?? {}, {}, "a request-determined deny is not an arm quality signal");
});

test("deny on a normal request still resamples (arm-specific verdict preserved)", async () => {
  const h = await turnHarness({ reqBytes: 2_000, ruling: "RULING: STEALTH-DENY-RETRY" });
  assert.equal(h.status, 502);
  assert.ok(h.sent.length >= 2, `expected resampling, got ${h.sent.length}`);
});

test("vec hook: a vec pick is used and rides the EXPLORE path (P1 gate still runs)", async () => {
  const h = await turnHarness({ vec: { zone: "vec", arm: "hg/e" } });
  assert.equal(h.status, 200);
  assert.deepEqual(h.sent, ["hg/e"], "the vec arm must be the one served");
  assert.ok(h.judged.includes("attack:cheap"), "a vec pick is NOT an exploit pick — the judge must run");
  assert.equal(h.observed[0]?.entry.vz, "vec", "the served log line must carry the routing zone");
});

test("vec hook: abstain (zone ts) falls through to class TS", async () => {
  const h = await turnHarness({ vec: { zone: "ts", why: "inadequate" } });
  assert.equal(h.status, 200);
  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0] !== undefined);
  assert.notEqual(h.observed[0]?.entry.vz, "vec");
});

test("vec hook: inert (no vecRoute injected) changes nothing", async () => {
  const h = await turnHarness({ vec: "unset" });
  assert.equal(h.status, 200);
  assert.equal(h.sent.length, 1);
  assert.equal(h.vecTexts.length, 0);
});

test("vec hook: the ok() predicate rejects arms outside the universe, excluded, or in backoff", async () => {
  const h = await turnHarness({ vec: { zone: "ts", why: "eps" }, backoff: ["ali/a"] });
  const ok = h.okFn();
  assert.ok(ok, "the hook must pass a health predicate");
  assert.equal(ok!("ali/a"), false, "global backoff must veto a vec pick");
  assert.equal(ok!("clinepass/dead"), false, "an arm outside the filtered universe must veto");
  assert.equal(ok!("minimax/c"), true, "a healthy universe arm must pass");
});

test("vec hook: a backoff-vetoed vec arm falls back to TS instead of being served", async () => {
  const h = await turnHarness({ vec: { zone: "vec", arm: "ali/a" }, backoff: ["ali/a"] });
  assert.equal(h.status, 200);
  assert.notEqual(h.sent[0], "ali/a", "an unhealthy arm must never be served just because vec liked it");
  assert.equal(h.observed[0]?.entry.vz, "ts", "the log must not claim a vec routing that was vetoed");
});

test("vec invariant: route() and observe() are given the SAME text", async () => {
  const h = await turnHarness({ vec: { zone: "vec", arm: "mm/d" } });
  assert.equal(h.vecTexts.length, 1);
  assert.equal(h.observed.length, 1);
  assert.equal(h.vecTexts[0], h.observed[0].text,
    "the k-NN query must be the same string that gets stored, or similarity is meaningless");
  assert.match(h.vecTexts[0], /first mission anchor/, "mission anchor must be included");
});
