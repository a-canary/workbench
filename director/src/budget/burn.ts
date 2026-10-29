import type { Limit } from "./meter.ts";

const WINDOW_MINUTES: Record<string, number> = {
  session: 300,
  weekly: 10080,
};

const SILO_THRESHOLDS: Record<string, number> = {
  public: 0.8,
  dev: 0.9,
  app: 1.0,
  trading: 1.2,
  llc: 1.2,
};

export function burnGate(
  ls: Limit[],
  silo: string,
  nowMs: number,
): { start: boolean; reason: string; burn: number | null } {
  // 1. Windows: active, scope == null, group session or weekly
  const windows = ls.filter(
    (l) => l.active && l.scope == null && WINDOW_MINUTES[l.group!] != null,
  );

  if (windows.length === 0 || windows.some((w) => !Number.isFinite(w.util))) {
    return { start: silo === "critical", reason: "meter-unreachable", burn: null };
  }

  // 2. util = max util over windows
  const util = Math.max(...windows.map((w) => w.util));

  // 3. Compute burn: max over windows with util >= 0.20
  let burn = 0;
  for (const w of windows) {
    if (w.util < 0.20) continue;
    const winMin = WINDOW_MINUTES[w.group!];
    let minutesLeft: number;
    if (w.reset == null) {
      minutesLeft = 0;
    } else {
      minutesLeft = Math.max(0, (Date.parse(w.reset) - nowMs) / 60000);
    }
    const elapsed = Math.min(1, Math.max(0, 1 - minutesLeft / winMin));
    const windowBurn = elapsed === 0 ? Infinity : w.util / elapsed;
    if (windowBurn > burn) burn = windowBurn;
  }

  // 4. critical silo is never gated
  if (silo === "critical") {
    return { start: true, reason: "critical", burn };
  }

  // 5. hard cap
  if (util >= 0.97) {
    return { start: false, reason: "hard-cap", burn };
  }

  // 6. low util allows everything
  if (util < 0.20) {
    return { start: true, reason: "low-util", burn };
  }

  // 7. burn vs silo threshold (strictly less)
  const threshold = SILO_THRESHOLDS[silo] ?? SILO_THRESHOLDS["public"];
  const ok = burn < threshold;
  return { start: ok, reason: ok ? "ok" : "burn", burn };
}
