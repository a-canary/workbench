// Pure dashboard steering transition: one form post → next steer-<lane>.json content, or an error string.
import type { Steer } from "../sprint/steer.ts";
export type { Steer };

const BEAD_ID_RE = /^[a-z0-9]+-[a-z0-9.]+$/i;
const drop = (a: string[], x: string) => a.filter((v) => v !== x);
const add = (a: string[], x: string) => (a.includes(x) ? [...a] : [...a, x]);

export function applySteer(s: Steer, f: { action: string; id?: string; text?: string }, now = new Date()): Steer | string {
  const id = (f.id ?? "").trim();
  const notes = [...s.notes];
  if (["pin", "skip", "unpin", "unskip"].includes(f.action) && !BEAD_ID_RE.test(id)) return "bad bead id";
  switch (f.action) {
    case "pin": return { pin: add(s.pin, id), skip: drop(s.skip, id), notes };
    case "skip": return { pin: drop(s.pin, id), skip: add(s.skip, id), notes };
    case "unpin": return { pin: drop(s.pin, id), skip: [...s.skip], notes };
    case "unskip": return { pin: [...s.pin], skip: drop(s.skip, id), notes };
    case "note": {
      const text = (f.text ?? "").trim();
      if (text.length < 1 || text.length > 2000) return "note must be 1–2000 chars";
      return { pin: [...s.pin], skip: [...s.skip], notes: [...notes, { ts: now.toISOString(), text }] };
    }
    case "clearnotes": return { pin: [...s.pin], skip: [...s.skip], notes: [] };
    default: return "unknown action";
  }
}
