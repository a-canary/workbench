export type Bead = {
  dir: string;
  id: string;
  priority: number;
  created_at: string;
  updated_at: string;
  title: string;
  labels: string[];
  issue_type: string;
  status: string;
};

export type Row = {
  dir: string;
  id: string;
  priority: number;
  created_at: string;
  title: string;
  pinned: boolean;
};

const STALE_MS = 48 * 60 * 60 * 1000;
const DROP_LABELS = new Set(["human", "lane:v100", "lane:free"]);

export function rank(
  ready: Bead[],
  inProgress: Bead[],
  steer: { pin: string[]; skip: string[] },
  now: number = Date.now(),
): Row[] {
  const pinSet = new Set(steer.pin);
  const skipSet = new Set(steer.skip);

  const rows: Row[] = [];

  for (const bead of ready) {
    if (bead.issue_type === "epic") continue;
    if (bead.labels.some((l) => DROP_LABELS.has(l))) continue;
    let title = bead.title.replace(/\t/g, " ");
    if (bead.labels.includes("decided")) title = "[decided] " + title;
    rows.push({
      dir: bead.dir,
      id: bead.id,
      priority: bead.priority,
      created_at: bead.created_at,
      title,
      pinned: pinSet.has(bead.id),
    });
  }

  for (const bead of inProgress) {
    if (bead.labels.includes("human")) continue;
    if (Date.parse(bead.updated_at) >= now - STALE_MS) continue;
    const title = "[stale-claim] " + bead.title.replace(/\t/g, " ");
    rows.push({
      dir: bead.dir,
      id: bead.id,
      priority: bead.priority,
      created_at: bead.created_at,
      title,
      pinned: pinSet.has(bead.id),
    });
  }

  return rows
    .filter((r) => !skipSet.has(r.id))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    });
}

export function format(rows: Row[]): string {
  return rows
    .map(
      (r) =>
        `${r.dir}\t${r.id}\tP${r.priority}\t${r.pinned ? "[pinned] " : ""}${r.title}`,
    )
    .join("\n");
}
