import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync, execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const WARN_PCT = 90;
const GC_TRIGGER_GB = 1;   // trigger GC when free drops below this
export const gcScript = () => process.env.PI_DISK_GC_SCRIPT || join(homedir(), "bin/disk-gc.sh");

function getDiskUsage(): { pct: number; availGb: number } {
  try {
    const out = execSync("df -P / | tail -1", { encoding: "utf-8" }).trim();
    const parts = out.split(/\s+/);
    const pct = parseInt(parts[4].replace("%", ""));
    const availKb = parseInt(parts[3]);
    return { pct, availGb: availKb / 1024 / 1024 };
  } catch {
    return { pct: 0, availGb: 999 };
  }
}

export function runGc(script = gcScript()): boolean {
  if (!existsSync(script)) return false;
  try {
    // no shell: a $HOME or PI_DISK_GC_SCRIPT with spaces/metacharacters is a path, not a command
    execFileSync(script, [], { timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!["write", "edit", "bash"].includes(event.toolName)) return;

    let disk = getDiskUsage();

    // Trigger GC when below threshold — free up to 5GB only
    if (disk.availGb < GC_TRIGGER_GB) {
      ctx.ui.notify(`Disk low (${disk.availGb.toFixed(1)}G free), running GC...`, "info");
      runGc();
      disk = getDiskUsage();
    }

    if (disk.pct >= WARN_PCT) {
      ctx.ui.notify(`Disk at ${disk.pct}% (${disk.availGb.toFixed(1)}G free)`, "warn");
    }
  });
}
