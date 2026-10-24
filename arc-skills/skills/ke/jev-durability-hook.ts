/**
 * jev-durability-hook.ts — pi extension that intercepts findings from `ke research`
 * and `ke learn` tool results, asks Jev (via systemone API) whether the finding
 * is durable enough for the knowledge base, and nags the agent to add it if yes.
 *
 * Usage: Place in ~/.pi/agent/extensions/ or symlink from there.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const JEV_URL = "http://localhost:8099/v1/systemone";
const DURABILITY_THRESHOLD = 0.5;

async function askJev(text: string): Promise<{ durable: number }> {
  const body = {
    questions: [
      {
        id: "durability",
        type: "labels",
        choices: ["durable", "transient"],
        question: `Is this finding durable enough for the knowledge base? Text: ${text.slice(0, 500)}`,
      },
    ],
  };
  try {
    const res = await fetch(JEV_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { durable: 0 };
    const data = await res.json();
    const q = data.questions?.[0];
    return { durable: q?.answers?.[0]?.score ?? 0 };
  } catch {
    return { durable: 0 };
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return { action: "continue" };

    const command = event.input?.command ?? "";
    if (!command.includes("ke research") && !command.includes("ke learn")) {
      return { action: "continue" };
    }

    const content = event.content ?? "";
    if (!content.trim()) return { action: "continue" };

    const { durable } = await askJev(content);
    if (durable >= DURABILITY_THRESHOLD) {
      const snippet = content.trim().slice(0, 80);
      try {
        ctx.sendMessage({
          customType: "ke-durability-nag",
          content: `[Jev] This finding scored durable (${durable.toFixed(2)}). Consider: ke learn "${snippet}..."`,
          display: true,
        });
      } catch { /* ignore */ }
    }
    return { action: "continue" };
  });
}
