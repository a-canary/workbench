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
// Parity with driver-next.sh: ready drops operator-gated and other-lane beads; the
// stale-claim pass drops only human and lane:v100 (a stale lane:free claim still surfaces).
const READY_DROP = new Set(["human", "lane:v100", "lane:free"]);
const CLAIM_DROP = new Set(["human", "lane:v100"]);
// One TSV row per bead: tabs and line breaks in a title become spaces.
const clean = (t: string) => t.replace(/[\t\r\n]+/g, " ");

export function rank(
  ready: Bead[],
  inProgress: Bead[],
  steer: { pin: string[]; skip: string[] },
  now: number = Date.now(),
): Row[] {
  const pinSet = new Set(steer.pin);
  const skipSet = new Set(steer.skip);
  const labels = (b: Bead) => b.labels ?? []; // bd omits labels on an unlabelled bead (and priority on a P0: the shell sorts the empty field as 0)
  const row = (b: Bead, title: string): Row => ({
    dir: b.dir, id: b.id, priority: b.priority ?? 0, created_at: b.created_at, title, pinned: pinSet.has(b.id),
  });
  const rows = [
    ...ready
      .filter((b) => b.issue_type !== "epic" && !labels(b).some((l) => READY_DROP.has(l)))
      .map((b) => row(b, (labels(b).includes("decided") ? "[decided] " : "") + clean(b.title))),
    // NaN (missing/garbled updated_at) is not >= cut, so it counts as stale, like the shell's string compare
    ...inProgress
      .filter((b) => !labels(b).some((l) => CLAIM_DROP.has(l)) && !(Date.parse(b.updated_at) >= now - STALE_MS))
      .map((b) => row(b, "[stale-claim] " + clean(b.title))),
  ];
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  // pinned, priority, created_at, then dir/id/title: the shell sort's whole-line tiebreak
  return rows
    .filter((r) => !skipSet.has(r.id))
    .sort((a, b) =>
      Number(b.pinned) - Number(a.pinned) || a.priority - b.priority || cmp(a.created_at, b.created_at) ||
      cmp(a.dir, b.dir) || cmp(a.id, b.id) || cmp(a.title, b.title));
}

export function format(rows: Row[]): string {
  return rows
    .map(
      (r) =>
        `${r.dir}\t${r.id}\tP${r.priority}\t${r.pinned ? "[pinned] " : ""}${r.title}`,
    )
    .join("\n");
}
