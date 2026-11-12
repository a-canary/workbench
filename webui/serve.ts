// Start the control pane server. Reads config dir from WORKBENCH_CONFIG.

import { loadConfig, handle } from "./pane";

const configDir = process.env.WORKBENCH_CONFIG;
if (!configDir) {
  console.error("WORKBENCH_CONFIG is required (path to config dir with pane.json)");
  process.exit(1);
}

const cfg = loadConfig(configDir);
const port = Number(process.env.PORT ?? 8081);
// The pane has no login: it listens on this machine only unless HOST names another address
// (for example a private-network address to reach it from a phone).
const host = process.env.HOST ?? "127.0.0.1";

// development: false keeps stack traces with file paths out of error responses.
Bun.serve({ port, hostname: host, development: false, fetch: (req) => handle(req, cfg) });
console.log(`control pane listening on ${host}:${port}`);
