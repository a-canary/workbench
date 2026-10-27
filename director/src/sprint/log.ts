export type Start = {
  ev: "start";
  ts: string;
  lane: string;
  dir: string;
  project: string;
  id: string;
  title: string;
  priority: number;
  mem: { key: string; text: string }[];
  ke: { score: number; title: string; path: string }[];
  steer: { ts: string; text: string }[];
};

export type End = {
  ev: "end";
  ts: string;
  lane: string;
  id: string;
  outcome: string;
  finding: string;
  metrics: Record<string, number>;
  mission: string;
  dir?: string;
  project?: string;
  title?: string;
  priority?: number;
};

export type Sprint = Start & { end?: End; minutes: number };

export function sprints(
  evs: (Start | End)[],
  lane: string,
  now = Date.now(),
): Sprint[] {
  const byLane = evs.filter((e) => e.lane === lane);
  const open = new Map<string, Start[]>();
  const results: Sprint[] = [];

  for (const ev of byLane) {
    if (ev.ev === "start") {
      const stack = open.get(ev.id) ?? [];
      stack.push(ev);
      open.set(ev.id, stack);
    } else {
      const stack = open.get(ev.id);
      if (stack && stack.length > 0) {
        const start = stack.pop()!;
        if (stack.length === 0) open.delete(ev.id);
        const endTs = Date.parse(ev.ts);
        const startTs = Date.parse(start.ts);
        results.push({
          ...start,
          end: ev,
          minutes: Math.max(0, Math.round((endTs - startTs) / 60000)),
        });
      } else {
        const endTs = Date.parse(ev.ts);
        results.push({
          ev: "start",
          ts: ev.ts,
          lane: ev.lane,
          dir: ev.dir ?? "",
          project: ev.project ?? "?",
          id: ev.id,
          title: ev.title ?? ev.id,
          priority: ev.priority ?? 4,
          mem: [],
          ke: [],
          steer: [],
          end: ev,
          minutes: NaN,
        });
      }
    }
  }

  for (const stack of open.values()) {
    for (const start of stack) {
      const startTs = Date.parse(start.ts);
      results.push({
        ...start,
        minutes: Math.max(0, Math.round((now - startTs) / 60000)),
      });
    }
  }

  results.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return results;
}

export function live(sp: Sprint[]): Sprint | undefined {
  if (sp.length > 0 && sp[0].end === undefined) {
    return sp[0];
  }
  return undefined;
}

export function trends(
  sp: Sprint[],
): { name: string; vals: number[]; ids: string[] }[] {
  const oldestFirst = [...sp].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts),
  );
  const series = new Map<string, { vals: number[]; ids: string[] }>();

  for (const s of oldestFirst) {
    if (s.end === undefined) continue;
    for (const [name, val] of Object.entries(s.end.metrics)) {
      if (!Number.isFinite(val)) continue;
      let entry = series.get(name);
      if (entry === undefined) {
        entry = { vals: [], ids: [] };
        series.set(name, entry);
      }
      entry.vals.push(val);
      entry.ids.push(s.id);
    }
  }

  const out: { name: string; vals: number[]; ids: string[] }[] = [];
  for (const [name, entry] of series.entries()) {
    out.push({ name, vals: entry.vals, ids: entry.ids });
  }
  return out;
}
