// sse-fix — Fork A: repair MiniMax-M3's XML tool-call leak on the SSE path.
//
// M3 sometimes emits its native tool-call XML (<minimax:tool_call><invoke …>)
// inside delta.content instead of structured tool_calls. Downstream (pi) then
// renders it as literal text (leak → dead turn), and a truncated block
// poisons the stream client (wedge → every later request times out at +300s).
// This Transform watches chat-completions SSE frames: complete blocks become
// proper delta.tool_calls (+ finish_reason rewritten to "tool_calls");
// truncated/malformed blocks are silently dropped so the poison never lands.
//
// Engaged only for streaming requests that carry tools (see server.ts);
// everything else passes bytes through unchanged. ponytail ceilings:
//  - prose legitimately quoting the tag gets converted if it parses as an
//    invoke block (rare; a parsed invoke there is almost always a real call)
//  - parameter values stay strings (observed usage is a single string param);
//    numeric coercion needs the request's tool schema — add if a multi-type
//    tool ever routes through here
//  - once <minimax:tool_call> is seen, all later text in that response is
//    treated as call payload until it parses or the stream ends

import { Transform } from "node:stream";

const MM_OPEN = "<minimax:tool_call>";
const MM_CLOSE = "</minimax:tool_call>";
const INVOKE_CLOSE = "</invoke>";
const INVOKE_RE = /<invoke name="([^"]*)">([\s\S]*?)<\/invoke>/;
const PARAM_RE = /<parameter name="([^"]*)">([\s\S]*?)<\/parameter>/g;

// length of the trailing slice of s that could be a split start of MM_OPEN
function splitTagHold(s: string): number {
  for (let k = Math.min(s.length, MM_OPEN.length - 1); k > 0; k--)
    if (MM_OPEN.startsWith(s.slice(s.length - k))) return k;
  return 0;
}

interface FixedCall {
  name: string;
  args: string; // JSON-stringified object of parameters
  id: string;
}

function parseInvoke(block: string): Omit<FixedCall, "id"> | null {
  const m = block.match(INVOKE_RE);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const p of block.matchAll(PARAM_RE)) params[p[1]] = p[2];
  return { name: m[1], args: JSON.stringify(params) };
}

export class SseToolCallFixer extends Transform {
  private carry = ""; // content-machine buffer
  private inCall = false; // saw MM_OPEN, waiting for the block to complete
  private nCalls = 0;
  private finishFixed = false;
  private meta: { id?: string; model?: string } = {};
  private pending: Buffer = Buffer.alloc(0);

  constructor() {
    super();
  }

  // ── content state machine ───────────────────────────────────────────────
  private step(content: string): { text: string; calls: Omit<FixedCall, "id">[] } {
    this.carry += content;
    let text = "";
    const calls: Omit<FixedCall, "id">[] = [];
    for (;;) {
      if (!this.inCall) {
        const i = this.carry.indexOf(MM_OPEN);
        if (i < 0) {
          const hold = splitTagHold(this.carry);
          if (hold) {
            text += this.carry.slice(0, this.carry.length - hold);
            this.carry = this.carry.slice(this.carry.length - hold);
          } else {
            text += this.carry;
            this.carry = "";
          }
          break;
        }
        text += this.carry.slice(0, i);
        this.carry = this.carry.slice(i);
        this.inCall = true;
        continue;
      }
      // collecting: complete on </invoke> (wrapper close is optional in the
      // wild — some leaks end at </invoke>) or on the full wrapper close
      const iInv = this.carry.indexOf(INVOKE_CLOSE);
      const iWrap = this.carry.indexOf(MM_CLOSE);
      if (iInv < 0 && iWrap < 0) break; // keep buffering
      let end: number;
      if (iInv >= 0 && (iWrap < 0 || iInv < iWrap)) end = iInv + INVOKE_CLOSE.length;
      else end = iWrap + MM_CLOSE.length;
      const block = this.carry.slice(0, end);
      this.carry = this.carry.slice(end);
      this.inCall = false;
      const c = parseInvoke(block);
      if (c) calls.push(c);
      // eat a following wrapper close and/or the newline M3 emits after
      this.carry = this.carry.replace(/^(?:\r?\n)?(?:\s*<\/minimax:tool_call>)?/, "");
      continue;
    }
    return { text, calls };
  }

  // stream end: flush held normal text; a still-incomplete call is the
  // poison case — drop it entirely rather than deliver truncated XML
  private drain(): string {
    const t = this.inCall ? "" : this.carry;
    this.carry = "";
    this.inCall = false;
    return t;
  }

  // ── SSE line processing ─────────────────────────────────────────────────
  private dataLine(j: unknown): string {
    return `data: ${JSON.stringify(j)}`;
  }

  private synthetic(content: string | null): string {
    const delta = content === null ? {} : { content };
    return this.dataLine({
      ...(this.meta.id ? { id: this.meta.id } : {}),
      ...(this.meta.model ? { model: this.meta.model } : {}),
      choices: [{ index: 0, delta, finish_reason: content === null ? "tool_calls" : null }],
    });
  }

  private line(l: string): string[] {
    if (!l.startsWith("data: ")) return [l];
    const payload = l.slice(6);
    if (payload === "[DONE]") {
      const out: string[] = [];
      const tail = this.drain();
      if (tail) out.push(this.synthetic(tail));
      if (this.nCalls > 0 && !this.finishFixed) out.push(this.synthetic(null));
      out.push(l);
      return out;
    }
    let j: {
      id?: string;
      model?: string;
      choices?: {
        delta?: { content?: unknown; tool_calls?: unknown[] };
        finish_reason?: string | null;
        index?: number;
      }[];
    };
    try {
      j = JSON.parse(payload);
    } catch {
      return [l];
    }
    const ch = j?.choices?.[0];
    if (!ch) return [l];
    if (typeof j.id === "string") this.meta = { id: j.id, model: j.model ?? this.meta.model };
    const content = typeof ch.delta?.content === "string" ? ch.delta.content : undefined;
    if (content === undefined) {
      if (ch.finish_reason) {
        this.finishFixed = true;
        if (this.nCalls > 0 && ch.finish_reason !== "tool_calls") ch.finish_reason = "tool_calls";
      }
      return [this.dataLine(j)];
    }
    const { text, calls } = this.step(content);
    // untouched frame → original bytes (also the empty-content no-op case)
    if (
      !calls.length &&
      text === content &&
      !(this.nCalls > 0 && ch.finish_reason && ch.finish_reason !== "tool_calls")
    )
      return [l];
    if (calls.length) {
      ch.delta!.tool_calls = calls.map((c) => ({
        index: this.nCalls++,
        id: "call_" + Math.random().toString(36).slice(2, 12),
        type: "function",
        function: c,
      }));
    }
    if (text) ch.delta!.content = text;
    else delete ch.delta!.content;
    if (ch.finish_reason) {
      this.finishFixed = true;
      if (this.nCalls > 0 && ch.finish_reason !== "tool_calls") ch.finish_reason = "tool_calls";
    }
    return [this.dataLine(j)];
  }

  // ── stream plumbing ──────────────────────────────────────────────────────
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) {
    this.pending = Buffer.concat([this.pending, chunk]);
    for (;;) {
      const nl = this.pending.indexOf(0x0a);
      if (nl < 0) break;
      let raw = this.pending.subarray(0, nl).toString("utf8");
      this.pending = this.pending.subarray(nl + 1);
      let cr = false;
      if (raw.endsWith("\r")) {
        raw = raw.slice(0, -1);
        cr = true;
      }
      try {
        for (const l of this.line(raw)) this.push(l + (cr ? "\r\n" : "\n"));
      } catch {
        this.push(raw + (cr ? "\r\n" : "\n")); // fail-open to passthrough
      }
    }
    cb();
  }

  _flush(cb: (e?: Error | null) => void) {
    if (this.pending.length) {
      const raw = this.pending.toString("utf8");
      this.pending = Buffer.alloc(0);
      try {
        for (const l of this.line(raw)) this.push(l + "\n");
      } catch {
        this.push(raw + "\n");
      }
    }
    const tail = this.drain();
    if (tail) this.push(this.synthetic(tail) + "\n");
    if (this.nCalls > 0 && !this.finishFixed) this.push(this.synthetic(null) + "\n");
    cb();
  }
}