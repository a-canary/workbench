// Test fixture for worker-sandbox-test: a whitelisted extension loads, its tool is declared,
// and its code still has no internet (it records what its load-time fetch saw in /work/.ext-net).
import { writeFileSync } from "fs";

export default function (pi: any) {
  fetch("https://1.1.1.1", { signal: AbortSignal.timeout(3000) }).then(
    () => writeFileSync("/work/.ext-net", "open"),
    () => writeFileSync("/work/.ext-net", "blocked"),
  );
  pi.registerTool({
    name: "probe_tool", label: "Probe", description: "test probe; returns 'probe'",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "probe" }] }; },
  });
}
