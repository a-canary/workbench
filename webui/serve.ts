// Start the control pane server. Reads config dir from WORKBENCH_CONFIG.

import { loadConfig, handle, allowedHosts, parsePort } from "./pane";

const configDir = process.env.WORKBENCH_CONFIG;
if (!configDir) {
  console.error("WORKBENCH_CONFIG is required (path to config dir with pane.json)");
  process.exit(1);
}

let cfg: ReturnType<typeof loadConfig>;
let port: number;
try {
  cfg = loadConfig(configDir);
  port = parsePort(process.env.PORT);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
// The pane has no login: it listens on this machine only unless PANE_HOST names another address
// (for example a private-network address to reach it from a phone).
// The name is specific on purpose: some shells and containers export a generic HOST variable.
const host = process.env.PANE_HOST || "127.0.0.1";

const hosts = allowedHosts(cfg, host, port);

// development: false keeps stack traces with file paths out of error responses.
Bun.serve({
  port,
  hostname: host,
  development: false,
  // A verdict form is a few fields and a note of at most 4000 characters.
  maxRequestBodySize: 64 * 1024,
  fetch: (req) => handle(req, { ...cfg, hosts }),
});
console.log(`control pane listening on ${host}:${port}`);
