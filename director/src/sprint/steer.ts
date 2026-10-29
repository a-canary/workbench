// Operator steering file (steer-<lane>.json {pin, skip, notes}) — port of ~/vault/director/scripts/sprint.ts.
import { readFileSync, writeFileSync } from "node:fs";

export type Steer = { pin: string[]; skip: string[]; notes: { ts: string; text: string }[] };

/** Raw file object, or {} when the file is missing, unparseable, or not a JSON object. */
function readRaw(path: string): Record<string, unknown> {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);
const norm = (raw: Record<string, unknown>): Steer => ({ pin: list(raw.pin), skip: list(raw.skip), notes: list(raw.notes) });

export const readSteer = (path: string): Steer => norm(readRaw(path));

/** Return the pending notes and write the file back with them cleared and `id` unpinned; other keys survive.
 * ponytail: read-modify-write with no lock; the dashboard and Driver rarely write within the same second. */
export function consumeSteer(path: string, id: string): Steer["notes"] {
  const raw = readRaw(path);
  const s = norm(raw);
  writeFileSync(path, JSON.stringify({ ...raw, ...s, pin: s.pin.filter((p) => p !== id), notes: [] }, null, 2));
  return s.notes;
}
