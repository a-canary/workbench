import { test } from "node:test";
import assert from "node:assert/strict";
import { laneCheck, type KeyInfo } from "../server.ts";

const priv: KeyInfo = { user: "operator", cls: "ux", lane: "private" };
const pub: KeyInfo = { user: "agent", cls: "ux", lane: "public" };
const nolane: KeyInfo = { user: "legacy", cls: "ux" };
const ext: KeyInfo = { user: "ext-abc", cls: "ux", external: true };

test("LANE unset → legacy open mode, everything passes", () => {
  assert.equal(laneCheck(undefined, priv), null);
  assert.equal(laneCheck(undefined, nolane), null);
  assert.equal(laneCheck(undefined, ext), null);
});

test("public lane: matching key ok, private rejected, unlabeled fail-closed", () => {
  assert.equal(laneCheck("public", pub), null);
  assert.match(String(laneCheck("public", priv)), /does not match/);
  assert.match(String(laneCheck("public", nolane)), /fail-closed/);
});

test("private lane: matching ok, public rejected, unlabeled fail-closed", () => {
  assert.equal(laneCheck("private", priv), null);
  assert.match(String(laneCheck("private", pub)), /does not match/);
  assert.match(String(laneCheck("private", nolane)), /fail-closed/);
});

test("external passthrough keys: public-only (ratchet — never on private lane)", () => {
  assert.equal(laneCheck("public", ext), null);
  assert.match(String(laneCheck("private", ext)), /not accepted on the private lane/);
});
