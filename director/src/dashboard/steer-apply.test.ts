import { describe, expect, test } from "bun:test";
import { applySteer } from "./steer-apply";

const empty = () => ({ pin: [] as string[], skip: [] as string[], notes: [] as { ts: string; text: string }[] });
const now = new Date("2026-10-28T12:00:00Z");

describe("applySteer", () => {
  test("pin adds once and removes from skip", () => {
    const s = { ...empty(), skip: ["wb-1"] };
    const a = applySteer(s, { action: "pin", id: " wb-1 " }, now);
    expect(a).toEqual({ pin: ["wb-1"], skip: [], notes: [] });
    expect(applySteer(a as any, { action: "pin", id: "wb-1" }, now)).toEqual({ pin: ["wb-1"], skip: [], notes: [] });
  });

  test("skip adds once and removes from pin; unpin/unskip remove", () => {
    const a = applySteer({ ...empty(), pin: ["wb-2"] }, { action: "skip", id: "wb-2" }, now) as any;
    expect(a).toEqual({ pin: [], skip: ["wb-2"], notes: [] });
    expect(applySteer(a, { action: "unskip", id: "wb-2" }, now)).toEqual(empty());
    expect(applySteer({ ...empty(), pin: ["wb-3", "wb-4"] }, { action: "unpin", id: "wb-3" }, now)).toEqual({ pin: ["wb-4"], skip: [], notes: [] });
  });

  test("bead-id actions reject ids that are not <prefix>-<suffix>", () => {
    for (const id of ["", "nodash", "a b-1", "x-1;rm", "-1"]) {
      expect(applySteer(empty(), { action: "pin", id }, now)).toBe("bad bead id");
    }
    expect(applySteer(empty(), { action: "skip", id: "wb-an0.5" }, now)).toEqual({ pin: [], skip: ["wb-an0.5"], notes: [] });
  });

  test("note appends trimmed text with ISO ts; clearnotes empties", () => {
    const a = applySteer(empty(), { action: "note", text: "  look at X  " }, now) as any;
    expect(a.notes).toEqual([{ ts: "2026-10-28T12:00:00.000Z", text: "look at X" }]);
    expect(applySteer(a, { action: "clearnotes" }, now)).toEqual(empty());
  });

  test("note length bounds and unknown action are errors", () => {
    expect(applySteer(empty(), { action: "note", text: "   " }, now)).toBe("note must be 1–2000 chars");
    expect(applySteer(empty(), { action: "note", text: "x".repeat(2001) }, now)).toBe("note must be 1–2000 chars");
    expect(applySteer(empty(), { action: "explode" }, now)).toBe("unknown action");
  });

  test("does not mutate its input", () => {
    const s = { ...empty(), pin: ["wb-5"] };
    applySteer(s, { action: "skip", id: "wb-5" }, now);
    applySteer(s, { action: "note", text: "n" }, now);
    expect(s).toEqual({ pin: ["wb-5"], skip: [], notes: [] });
  });
});
