// Operator steering file (steer-<lane>.json {pin, skip, notes}): read it, and consume it when a Sprint starts.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSteer, consumeSteer } from "./steer.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "steer-")), "steer-claude.json");
const note = (text: string) => ({ ts: "2026-10-28T00:00:00.000Z", text });

test("readSteer: missing or unparseable file is empty steering", () => {
  const p = tmp();
  expect(readSteer(p)).toEqual({ pin: [], skip: [], notes: [] });
  writeFileSync(p, "{not json");
  expect(readSteer(p)).toEqual({ pin: [], skip: [], notes: [] });
});

test("readSteer: fills absent fields", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ pin: ["a"] }));
  expect(readSteer(p)).toEqual({ pin: ["a"], skip: [], notes: [] });
});

test("consumeSteer: returns notes once, drops the started pin, keeps the rest", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ pin: ["a", "b"], skip: ["c"], notes: [note("do x first")], extra: 1 }));
  expect(consumeSteer(p, "a")).toEqual([note("do x first")]);
  expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ pin: ["b"], skip: ["c"], notes: [], extra: 1 });
  expect(consumeSteer(p, "b")).toEqual([]);
  expect(readSteer(p)).toEqual({ pin: [], skip: ["c"], notes: [] });
});

test("consumeSteer: missing file writes empty steering", () => {
  const p = tmp();
  expect(consumeSteer(p, "a")).toEqual([]);
  expect(readSteer(p)).toEqual({ pin: [], skip: [], notes: [] });
});
