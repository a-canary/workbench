// Sprint CLI parsing: bead-title keywords, `bd memories` / `ke research` output, and `end` arguments.
import { test, expect } from "bun:test";
import { keywords, parseMemories, parseKe, parseEnd } from "./parse.ts";

test("keywords: lowercase, drop [tags] and stopwords, dedupe, first 3 of length >= 4", () => {
  expect(keywords("[decided] Port the Sprint CLI with recall into workbench sprint")).toEqual(["port", "sprint", "recall"]);
  expect(keywords("fix: a b cd")).toEqual([]);
  expect(keywords("lane-proxy V100 reclaim after idle")).toEqual(["lane-proxy", "v100", "reclaim"]);
});

test("parseMemories: 2-space key line, 4-space text line, text capped at 200 chars", () => {
  const out = "  sprint-log\n    pairs start and end\n    second line ignored\n  ke-optional\n    " + "x".repeat(250) + "\n  bare-key\n";
  expect(parseMemories(out)).toEqual([
    { key: "sprint-log", text: "pairs start and end" },
    { key: "ke-optional", text: "x".repeat(200) },
    { key: "bare-key", text: "" },
  ]);
  expect(parseMemories("")).toEqual([]);
  expect(parseMemories("    orphan text\nno indent\n")).toEqual([]);
});

test("parseKe: '- [score%] title' then '  → path'; first path wins", () => {
  const out = "- [46.8%] Sprint protocol \n  → ke/notes/sprint.md\n  → ignored.md\n- [12%] Other\nnoise\n";
  expect(parseKe(out)).toEqual([
    { score: 46.8, title: "Sprint protocol", path: "ke/notes/sprint.md" },
    { score: 12, title: "Other", path: "" },
  ]);
  expect(parseKe("")).toEqual([]);
});

test("parseEnd: id, outcome, finding, numeric metrics, mission", () => {
  expect(parseEnd(["wb-1", "done", "shipped it", "tests=12", "lat_ms=3.5", "mission=autonomy: fewer gates"])).toEqual({
    id: "wb-1", outcome: "done", finding: "shipped it", metrics: { tests: 12, lat_ms: 3.5 }, mission: "autonomy: fewer gates",
  });
});

test("parseEnd: skips non-numeric, empty, and key-less pairs", () => {
  expect(parseEnd(["wb-1", "checkpoint", "f", "note=abc", "blank=", "sp= ", "=5", "nokv", "inf=Infinity", "x=1e3"])).toEqual({
    id: "wb-1", outcome: "checkpoint", finding: "f", metrics: { x: 1000 }, mission: "",
  });
});

test("parseEnd: rejects a bad outcome or too few args", () => {
  expect(parseEnd(["wb-1", "finished", "f"])).toEqual({ error: "outcome: done|checkpoint|blocked" });
  expect(parseEnd(["wb-1", "done"])).toEqual({ error: "usage" });
});

test("parsers match sprint.ts on edge input: CRLF keys, empty ke title, malformed score", () => {
  expect(parseMemories("  k1\r\n    text\r").map((m) => m.key)).toEqual(["k1"]);
  expect(parseKe("- [5%] \n  → /p")).toEqual([]);
  expect(Number.isNaN(parseKe("- [1.2.3%] t")[0]!.score)).toBe(true);
});
