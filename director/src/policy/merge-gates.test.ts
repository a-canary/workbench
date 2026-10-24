import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { checkMergeGates } from "./merge-gates";
import { writeFileSync, unlinkSync } from "node:fs";

const REPORT_PATH = "/tmp/test-hardmerge-report.md";
const HOME = "/home/testuser";

beforeAll(() => {
  writeFileSync(REPORT_PATH, "CLEAR\n");
});

afterAll(() => {
  unlinkSync(REPORT_PATH);
});

describe("merge-gates", () => {
  it("passes when all gates satisfied", () => {
    const v = checkMergeGates({
      diffSource: "/home/testuser/worktrees/project-feature",
      ponytailFindings: 2,
      hardMergeReport: REPORT_PATH,
      home: HOME,
    });
    expect(v.ok).toBe(true);
    expect(v.failedGates).toEqual([]);
  });

  it("fails worktree-isolation for main checkout", () => {
    const v = checkMergeGates({
      diffSource: "/home/testuser/repos/project",
      ponytailFindings: 0,
      hardMergeReport: REPORT_PATH,
      home: HOME,
    });
    expect(v.ok).toBe(false);
    expect(v.failedGates).toContain("worktree-isolation");
  });

  it("fails worktree-isolation for /tmp", () => {
    const v = checkMergeGates({
      diffSource: "/tmp/random-changes",
      ponytailFindings: 0,
      hardMergeReport: REPORT_PATH,
      home: HOME,
    });
    expect(v.ok).toBe(false);
    expect(v.failedGates).toContain("worktree-isolation");
  });

  it("fails ponytail-review when not run", () => {
    const v = checkMergeGates({
      diffSource: "/home/testuser/worktrees/project-feature",
      hardMergeReport: REPORT_PATH,
      home: HOME,
    });
    expect(v.ok).toBe(false);
    expect(v.failedGates).toContain("ponytail-review");
  });

  it("fails ponytail-review when too many findings", () => {
    const v = checkMergeGates({
      diffSource: "/home/testuser/worktrees/project-feature",
      ponytailFindings: 5,
      hardMergeReport: REPORT_PATH,
      home: HOME,
    });
    expect(v.ok).toBe(false);
    expect(v.failedGates).toContain("ponytail-review");
    expect(v.reasons[0]).toContain("5 complexity items");
  });

  it("passes ponytail-review at exactly 3 findings", () => {
    const v = checkMergeGates({
      diffSource: "/home/testuser/worktrees/project-feature",
      ponytailFindings: 3,
      hardMergeReport: REPORT_PATH,
      home: HOME,
    });
    expect(v.ok).toBe(true);
  });

  it("fails hard-merge when no report", () => {
    const v = checkMergeGates({
      diffSource: "/home/testuser/worktrees/project-feature",
      ponytailFindings: 0,
      home: HOME,
    });
    expect(v.ok).toBe(false);
    expect(v.failedGates).toContain("hard-merge");
  });

  it("fails when all three gates fail", () => {
    const v = checkMergeGates({
      diffSource: "/home/testuser/repos/project",
      ponytailFindings: 10,
      home: HOME,
    });
    expect(v.ok).toBe(false);
    expect(v.failedGates.length).toBe(3);
    expect(v.failedGates).toContain("worktree-isolation");
    expect(v.failedGates).toContain("ponytail-review");
    expect(v.failedGates).toContain("hard-merge");
  });
});
