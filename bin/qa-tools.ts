// qa-tools — the QA profile's only actions, as fixed-argv tools (no shell, no bash tool).
// Runs inside the worker-sandbox jail: the only writable dir is /out, the only network is the
// app door at 127.0.0.1:$APP_PORT, chrome is bound at /opt/chrome, img-collapse at /opt/wb.
import { execFile } from "child_process";
import { existsSync } from "fs";

const NAME = /^[a-z0-9_-]{1,40}$/;
const text = (t: string) => ({ content: [{ type: "text", text: t }], details: {} });
const run = (cmd: string, args: string[]) =>
  new Promise<string>((ok) =>
    execFile(cmd, args, { timeout: 60_000 }, (e, out, err) => ok(e ? `ERROR: ${e.message}\n${err}` : `${out}${err}`)),
  );

export default function (pi: any) {
  pi.registerTool({
    name: "screenshot",
    label: "Screenshot",
    description:
      "Screenshot a page of the app under test. path = URL path on the app (e.g. '/' or '/driver?x=1'); " +
      "name = output file stem [a-z0-9_-]; saved as /out/<name>.png. Optional width/height (default 1280x2000).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        name: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
      },
      required: ["path", "name"],
    },
    async execute(_id: string, p: any) {
      const port = process.env.APP_PORT;
      if (!port) return text("ERROR: no app door (worker-sandbox --app-port not set)");
      if (!NAME.test(p.name)) return text("ERROR: name must match [a-z0-9_-]{1,40}");
      if (typeof p.path !== "string" || !p.path.startsWith("/")) return text("ERROR: path must start with /");
      const w = Math.min(Math.max(p.width ?? 1280, 200), 4000), h = Math.min(Math.max(p.height ?? 2000, 200), 20000);
      const out = `/out/${p.name}.png`;
      const log = await run("/opt/chrome/chrome-headless-shell", [
        "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars",
        `--window-size=${w},${h}`, `--screenshot=${out}`, `http://127.0.0.1:${port}${p.path}`,
      ]);
      return text(existsSync(out) ? `saved ${out} (${w}x${h})` : `ERROR: no screenshot\n${log.slice(-800)}`);
    },
  });
  // a text-only model can't see screenshots and will invent their content; this is its ground truth
  pi.registerTool({
    name: "page_text",
    label: "Page text",
    description:
      "Render a page of the app under test (JS runs) and return its visible text, with links as 'text [href]'. " +
      "path = URL path on the app. Use this to verify content, errors (e.g. 404) and links.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute(_id: string, p: any) {
      const port = process.env.APP_PORT;
      if (!port) return text("ERROR: no app door (worker-sandbox --app-port not set)");
      if (typeof p.path !== "string" || !p.path.startsWith("/")) return text("ERROR: path must start with /");
      const dom = await run("/opt/chrome/chrome-headless-shell", [
        "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--dump-dom", `http://127.0.0.1:${port}${p.path}`,
      ]);
      const t = dom
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
        .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 [$1]")
        .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
        .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
      return text(t.slice(0, 8000) || "(empty page)");
    },
  });
  pi.registerTool({
    name: "img_collapse",
    label: "Collapse image",
    description:
      "Collapse dead space in /out/<name>.png for cheaper vision ingestion. Writes /out/<name>.collapsed.png " +
      "plus a .map.json sidecar; prints before/after size.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async execute(_id: string, p: any) {
      if (!NAME.test(p.name)) return text("ERROR: name must match [a-z0-9_-]{1,40}");
      const src = `/out/${p.name}.png`;
      if (!existsSync(src)) return text(`ERROR: ${src} not found`);
      return text(await run("python3", ["/opt/wb/img-collapse", "collapse", src, `/out/${p.name}.collapsed.png`]));
    },
  });
}
