#!/usr/bin/env -S node --experimental-strip-types
/**
 * arc-context-proxy HTTP server — OpenAI-compatible passthrough and census modes
 * /v1/chat/completions that relays to BACKEND or decomposes via census pipeline.
 * The census pipeline (prompt decomposition / multi-unit verdict) lives in
 * src/pipeline.ts and can be invoked via ACP_MODE=census.
 *
 * Env:
 *   ACP_PORT    (default 7891)
 *   ACP_BACKEND (default http://127.0.0.1:7890/v1)
 *   ACP_MODEL   model sent to backend (no default; required if the body has none)
 *   ACP_KEY     api key header (default acp)
 *   ACP_MODE    census|passthrough (default passthrough)
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.ACP_PORT ?? "7891");
const BACKEND = (process.env.ACP_BACKEND ?? "http://127.0.0.1:7890/v1").replace(/\/$/, "");
const DEFAULT_MODEL = process.env.ACP_MODEL ?? "";
const KEY = process.env.ACP_KEY ?? "acp";
const MODE = (process.env.ACP_MODE ?? "passthrough") as "census" | "passthrough";
const CAP = 32768; // featherless plan limit — same as pipeline.ts

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: string[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => ok(chunks.join("")));
    req.on("error", fail);
  });
}

/**
 * ponytail: token estimate using char-based heuristic.
 * Measured in pipeline.ts ~1.56 tok/word; at ~4.5 chars/word that's ~0.35 tok/char.
 * Headroom: use 0.4 to avoid overflow.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.4);
}

/**
 * Split content into chunks that fit within CAP minus overhead for system message,
 * instructions, and response tokens.
 * ponytail: conservative estimate — leaves ~8k tokens for instructions and response.
 */
function chunkContent(content: string, systemSize: number): string[] {
  const budgetPerChunk = Math.max(1000, CAP - systemSize - 8000);
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    // Estimate how many chars fit in the budget
    const maxChars = Math.ceil(budgetPerChunk / 0.4);
    chunks.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars);
  }

  return chunks;
}

async function callBackend(
  bodyObj: any,
  path: string,
  targetModel: string,
): Promise<{ status: number; text: string; callCount: number }> {
  const beReq = await fetch(`${BACKEND}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${KEY}`,
      "OpenAI-Organization": "arc-context-proxy",
    },
    body: JSON.stringify({ ...bodyObj, model: targetModel }),
    signal: AbortSignal.timeout(300_000),
  });

  return { status: beReq.status, text: await beReq.text(), callCount: 1 };
}

/**
 * Census mode: decompose into multiple calls if prompt exceeds CAP.
 * ponytail: concatenates chunks with minimal overhead; no per-chunk instructions.
 * Each call gets the full system context, splits the user content, and runs to completion.
 */
async function censusSplit(
  bodyObj: any,
  path: string,
  targetModel: string,
): Promise<{ status: number; text: string; callCount: number }> {
  if (!Array.isArray(bodyObj.messages)) {
    return callBackend(bodyObj, path, targetModel);
  }

  // Estimate total token cost
  const systemTokens = bodyObj.messages
    .filter((m: any) => m.role === "system")
    .reduce((sum: number, m: any) => sum + estimateTokens(m.content || ""), 0);

  const userContent = bodyObj.messages
    .filter((m: any) => m.role === "user")
    .map((m: any) => m.content || "")
    .join("\n");

  const userTokens = estimateTokens(userContent);
  const totalTokens = systemTokens + userTokens;

  // If it fits in one call, no split needed
  if (totalTokens < CAP) {
    return callBackend(bodyObj, path, targetModel);
  }

  // Split required: make multiple calls, each with a chunk of user content
  const chunks = chunkContent(userContent, systemTokens);
  let lastResponse: { status: number; text: string } | null = null;

  for (const chunk of chunks) {
    const chunkBody = {
      ...bodyObj,
      messages: [
        ...bodyObj.messages.filter((m: any) => m.role === "system"),
        { role: "user", content: chunk },
      ],
    };

    const result = await callBackend(chunkBody, path, targetModel);
    lastResponse = { status: result.status, text: result.text };

    if (result.status !== 200) {
      // If any call fails, return the error
      return { status: result.status, text: result.text, callCount: chunks.length };
    }
  }

  // Return the last response; all chunks processed
  return {
    status: lastResponse?.status ?? 500,
    text: lastResponse?.text ?? '{"error":{"message":"no response"}}',
    callCount: chunks.length,
  };
}

async function proxy(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  path: string,
) {
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
  const body = await readBody(req);

  const bodyObj = JSON.parse(body);
  const targetModel = bodyObj.model ?? DEFAULT_MODEL;
  if (!targetModel) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "no model in body and ACP_MODEL unset" } }));
    return;
  }

  const result = MODE === "census"
    ? await censusSplit(bodyObj, path, targetModel)
    : await callBackend(bodyObj, path, targetModel);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (MODE === "census") {
    headers["X-Call-Count"] = String(result.callCount);
  }
  res.writeHead(result.status, headers);
  res.end(result.text);
}

const server = createServer();
server.on("request", async (req, res) => {
  const url = req.url ?? "";
  try {
    if (url.startsWith("/v1/chat/completions")) {
      await proxy(req, res, "/chat/completions");
    } else if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", backend: BACKEND, model: DEFAULT_MODEL }));
    } else if (url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ id: DEFAULT_MODEL, object: "model", owned_by: "arc-context-proxy" }],
      }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found" } }));
    }
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(e) } }));
  }
});

server.listen(PORT, () => process.stdout.write(`arc-context-proxy ${MODE} mode on http://127.0.0.1:${PORT}\n`));
