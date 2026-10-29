export type Limit = {
  kind: string | undefined;
  group: string | undefined;
  util: number;
  reset: string | null;
  active: boolean;
  scope: string | null;
};

export type Meter = {
  util: number;
  limited: boolean;
};

export function parseUsage(j: unknown): Limit[] {
  if (j == null || typeof j !== "object") return [];
  const limits = (j as { limits?: unknown }).limits;
  if (!Array.isArray(limits)) return [];

  return limits.map((raw: any) => {
    const percent = raw?.percent;
    const util = typeof percent === "number" ? percent / 100 : NaN;
    const resetsAt = raw?.resets_at;
    const isActive = raw?.is_active;
    const model = raw?.scope?.model;
    return {
      kind: raw?.kind,
      group: raw?.group,
      util,
      reset: resetsAt ?? null,
      active: !!isActive,
      scope: model?.display_name ?? null,
    };
  });
}

export function meterOf(ls: Limit[]): Meter | null {
  const candidates = ls.filter(
    (l) => l.active && l.scope == null && (l.group === "session" || l.group === "weekly"),
  );
  if (candidates.length === 0) return null;
  for (const l of candidates) {
    if (!Number.isFinite(l.util)) return null;
  }
  const util = Math.max(...candidates.map((l) => l.util));
  return { util, limited: util >= 1 };
}

export function budgetGate(
  m: Meter | null,
  localQueued: number,
  threshold = 0.9,
): { claude: boolean; reason: string } {
  if (m == null) {
    return { claude: localQueued === 0, reason: "meter-unreachable" };
  }
  if (m.limited) {
    return { claude: false, reason: "limited" };
  }
  if (m.util >= threshold) {
    return { claude: localQueued === 0, reason: "local-first" };
  }
  return { claude: true, reason: "ok" };
}
