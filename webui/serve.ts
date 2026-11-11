// Start the control pane server. Reads config dir from WORKBENCH_CONFIG.

import { loadConfig, handle } from "./pane";

const configDir = process.env.WORKBENCH_CONFIG;
if (!configDir) {
  console.error("WORKBENCH_CONFIG is required (path to config dir with pane.json)");
  process.exit(1);
}

const cfg = loadConfig(configDir);
const port = Number(process.env.PORT ?? 8081);
const host = process.env.HOST ?? "0.0.0.0";

Bun.serve({ port, hostname: host, fetch: (req) => handle(req, cfg) });
console.log(`control pane listening on ${host}:${port}`);
