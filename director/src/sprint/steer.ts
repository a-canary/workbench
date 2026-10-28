import { readFileSync, writeFileSync, existsSync } from "node:fs";

export type Steer = { pin: string[]; skip: string[]; notes: { ts: string; text: string }[] };

const EMPTY: Steer = { pin: [], skip: [], notes: [] };

export function readSteer(path: string): Steer {
  if (!existsSync(path)) return EMPTY;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      pin: Array.isArray(raw.pin) ? raw.pin : [],
      skip: Array.isArray(raw.skip) ? raw.skip : [],
      notes: Array.isArray(raw.notes) ? raw.notes : [],
    };
  } catch {
    return EMPTY;
  }
}

export function consumeSteer(path: string, id: string): Steer["notes"] {
  let raw: object;
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      raw = EMPTY;
    }
  } else {
    raw = EMPTY;
  }
  const steer = {
    pin: Array.isArray(raw.pin) ? raw.pin : [],
    skip: Array.isArray(raw.skip) ? raw.skip : [],
    notes: Array.isArray(raw.notes) ? raw.notes : [],
  };
  const notes = steer.notes;
  // Preserve all keys from the file, only mutating pin and notes.
  const next = { ...raw, pin: steer.pin.filter((p) => p !== id), notes: [] };
  writeFileSync(path, JSON.stringify(next, null, 2));
  return notes;
}
