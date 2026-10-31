import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "child_process";

const WARN_PCT = 90;
const GC_TRIGGER_GB = 1;   // trigger GC when free drops below this
const GC_TARGET_GB = 5;    // free at most this much via GC
// lane task: resolve the GC script from $PI_DISK_GC_SCRIPT, else $HOME/bin/disk-gc.sh (see bin/disk-guard-test).
const GC_SCRIPT = "";

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

function estimateSizeGb(toolName: string, args: any): number {
  if (toolName === "write") {
    return (args.content?.length || 0) / 1024 / 1024 / 1024;
  }
  if (toolName === "edit") {
    const total = args.edits?.reduce((s: number, e: any) => s + (e.newText?.length || 0), 0) || 0;
    return total / 1024 / 1024 / 1024;
  }
  if (toolName === "bash") {
    const cmd = args.command || "";
    if (/git clone/.test(cmd)) return 1;
    if (/(npm|pnpm|yarn)\s+install/.test(cmd)) return 0.5;
    if (/pip\s+install/.test(cmd)) return 0.1;
    if (/(wget|curl)\s+.*\.(tar\.gz|zip)/.test(cmd)) return 2;
    if (/dd\s+if=/.test(cmd)) return 5;
    return 0.01;
  }
  return 0.001;
}

function runGc(): boolean {
  try {
    execSync(GC_SCRIPT, { timeout: 30000 });
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
