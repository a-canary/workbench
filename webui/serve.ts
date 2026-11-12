// Start the control pane server. Reads config dir from WORKBENCH_CONFIG.

import { loadConfig, handle, allowedHosts, parsePort } from "./pane";

const configDir = process.env.WORKBENCH_CONFIG;
if (!configDir) {
  console.error("WORKBENCH_CONFIG is required (path to config dir with pane.json)");
  process.exit(1);
}

const cfg = loadConfig(configDir);
let port: number;
try {
  port = parsePort(process.env.PORT);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
// The pane has no login: it listens on this machine only unless HOST names another address
// (for example a private-network address to reach it from a phone).
const host = process.env.HOST ?? "127.0.0.1";

const hosts = allowedHosts(cfg, host, port);

// development: false keeps stack traces with file paths out of error responses.
Bun.serve({ port, hostname: host, development: false, fetch: (req) => handle(req, { ...cfg, hosts }) });
console.log(`control pane listening on ${host}:${port}`);
