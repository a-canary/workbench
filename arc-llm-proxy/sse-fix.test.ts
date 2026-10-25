// Fork A tests: SseToolCallFixer over synthetic SSE byte streams.
// Shapes taken from real RRDM-session leaks (2026-09-10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { SseToolCallFixer } from "./sse-fix.ts";
import { Writable } from "node:stream";

// pipe one or many byte-chunks through a fixer, return the output text
async function run(chunks: string[]): Promise<string> {
  let out = "";
  const w = new Writable({
    write(c: Buffer, _e: any, cb: (e?: Error | null) => void) {
      out += c.toString("utf8");
      cb();
    },
  });
  const f = new SseToolCallFixer();
  const done = new Promise<void>((res) => w.on("finish", () => res()));
  f.pipe(w);
  for (const c of chunks) f.write(c);
  f.end();
  await done;
  return out;
}

const frame = (delta: unknown, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "x1", model: "m", choices: [{ index: 0, delta, ...extra }] })}\n\n`;

function callsIn(text: string): any[] {
  const out: any[] = [];
  for (const m of text.matchAll(/"tool_calls":(\[[^\]]*\])/g))
    out.push(JSON.parse(m[1]));
  return out;
}

test("plain stream passes through untouched", async () => {
  const s = frame({ role: "assistant" }) + frame({ content: "hello world" }) + frame({ content: "" }, { finish_reason: "stop" }) + "data: [DONE]\n\n";
  const out = await run([s]);
  assert.equal(out, s);
});

test("complete tool call split across many chunks becomes tool_calls", async () => {
  const xml = '<minimax:tool_call>\n<invoke name="bash">\n<parameter name="command">ls -la</parameter></invoke>\n';
  // split mid-tag, mid-argument — the realistic token-delta case
  const s =
    frame({ content: "Working on it. " }) +
    frame({ content: xml }) +
    frame({ content: "" }, { finish_reason: "stop" }) +
    "data: [DONE]\n\n";
  // feed in 7-byte chunks to force tag splitting
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += 7) chunks.push(s.slice(i, i + 7));
  const out = await run(chunks);
  assert.ok(!out.includes("minimax:tool_call"), "no XML may survive in output");
  assert.ok(out.includes("Working on it."), "leading prose survives");
  const calls = callsIn(out);
  assert.equal(calls.length, 1);
  const fn = calls[0][0].function;
  assert.equal(fn.name, "bash");
  assert.deepEqual(JSON.parse(fn.args), { command: "ls -la" });
  assert.ok(out.includes('"finish_reason":"tool_calls"'), "finish_reason rewritten");
  assert.ok(out.includes("data: [DONE]"), "[DONE] passed through");
});

test("truncated tool call (wedge shape) is dropped, stream stays clean", async () => {
  const s =
    frame({ content: "I will run the check. " }) +
    frame({ content: '<minimax:tool_call>\n<invoke name="bash">\n<parameter name="command">cd ~/repos/RRDM && grep -vE "Warning' }) +
    "data: [DONE]\n\n";
  const out = await run([s]);
  assert.ok(!out.includes("minimax:tool_call"), "poison never reaches the client");
  assert.ok(!out.includes("invoke"), "no partial XML of any kind");
  assert.ok(out.includes("I will run the check."), "pre-tag prose survives");
  assert.ok(!out.includes("tool_calls"), "no bogus tool call emitted");
});

test("text before, call, text after", async () => {
  const s =
    frame({ content: "before " }) +
    frame({ content: '<minimax:tool_call>\n<invoke name="bash">\n<parameter name="command">pwd</parameter></invoke>\n</minimax:tool_call>' }) +
    frame({ content: " after" }) +
    "data: [DONE]\n\n";
  const out = await run([s]);
  assert.ok(!out.includes("minimax"));
  assert.ok(out.includes('"content":"before "'));
  assert.ok(out.includes('"content":" after"'));
  assert.equal(callsIn(out).length, 1);
});

test("invoke-close without wrapper-close still converts (observed shape)", async () => {
  const s =
    frame({ content: '<minimax:tool_call>\n<invoke name="bash">\n<parameter name="command">echo hi</command></parameter></invoke>\n' }) +
    "data: [DONE]\n\n";
  const out = await run([s]);
  assert.ok(!out.includes("minimax"), "XML stripped");
  const calls = callsIn(out);
  assert.equal(calls.length, 1, "call extracted despite missing wrapper close");
  assert.ok(out.includes('"finish_reason":"tool_calls"'), "synthetic finish frame");
  assert.ok(out.includes("data: [DONE]"), "[DONE] still last");
});

test("comments and keep-alive lines pass through", async () => {
  const s = ": keep-alive\n\ndata: [DONE]\n\n";
  assert.equal(await run([s]), s);
});
// Tool-leak gate: leaked tool-call markup as turn text must deny (not reach judge).
import { TOOL_LEAK_RE } from "./auto-llm.ts";

test("tool-leak regex catches known upstream leak formats", () => {
  // verbatim from the 2026-09-10 approved-and-wedged RRDM turn
  const real = ' minimax:tool_call]<]minimax[>[<invoke name="bash">]<]minimax[>[<command>grep -n "torch.zeros(1, k_new"\n /home/user/repos/RRDM/scripts/g5p2_seqwarm.py]<]minimax[>[</command>]<]minimax[>[</invoke>';
  assert.ok(TOOL_LEAK_RE.test(real), "real-world minimax leak");
  assert.ok(TOOL_LEAK_RE.test('<tool_call>{"name":"bash","arguments":{}}'), "qwen tool_call");
  assert.ok(TOOL_LEAK_RE.test('<invoke name="bash"><command>ls</command></invoke>'), "cline invoke");
  assert.ok(!TOOL_LEAK_RE.test('tid = torch.zeros(k_new, device=device)'), "plain code");
  assert.ok(!TOOL_LEAK_RE.test('see the <tool> docs for details'), "html-ish word");
});
