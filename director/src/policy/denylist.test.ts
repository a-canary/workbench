import { describe, it, expect } from "bun:test";
import { checkCommand } from "./denylist";

describe("denylist — blocked (always)", () => {
  it("blocks rm -rf /", () => {
    expect(checkCommand("rm -rf /").ok).toBe(false);
  });

  it("blocks rm -rf outside worktrees", () => {
    const v = checkCommand("rm -rf ~/repos");
    expect(v.ok).toBe(false);
    expect(v.tier).toBe("blocked");
  });

  it("allows rm -rf in worktrees", () => {
    expect(checkCommand("rm -rf ~/worktrees/test-project").ok).toBe(true);
  });

  it("allows rm -rf in /tmp", () => {
    expect(checkCommand("rm -rf /tmp/build").ok).toBe(true);
  });

  it("blocks DROP TABLE", () => {
    const v = checkCommand("sqlite3 db.sqlite 'DROP TABLE users'");
    expect(v.ok).toBe(false);
    expect(v.tier).toBe("blocked");
  });

  it("blocks TRUNCATE TABLE", () => {
    expect(checkCommand("TRUNCATE TABLE orders").ok).toBe(false);
  });

  it("blocks git push --force", () => {
    expect(checkCommand("git push --force origin main").ok).toBe(false);
  });

  it("blocks git push -f", () => {
    expect(checkCommand("git push -f").ok).toBe(false);
  });

  it("allows git push (no force)", () => {
    expect(checkCommand("git push origin feature-branch").ok).toBe(true);
  });

  it("blocks git reset --hard main", () => {
    expect(checkCommand("git reset --hard main").ok).toBe(false);
  });

  it("blocks git reset --hard origin/master", () => {
    expect(checkCommand("git reset --hard origin/master").ok).toBe(false);
  });

  it("allows git reset --hard on feature branch", () => {
    expect(checkCommand("git reset --hard HEAD~1").ok).toBe(true);
  });
});

describe("denylist — escalated (requires approval)", () => {
  it("escalates deleting main branch", () => {
    const v = checkCommand("git branch -D main");
    expect(v.ok).toBe(false);
    expect(v.tier).toBe("escalated");
  });

  it("allows deleting feature branch", () => {
    expect(checkCommand("git branch -d feature-test").ok).toBe(true);
  });

  it("escalates docker system prune", () => {
    expect(checkCommand("docker system prune -a").ok).toBe(false);
  });

  it("escalates format", () => {
    expect(checkCommand("format /dev/sdb").ok).toBe(false);
  });

  it("escalates mkfs", () => {
    expect(checkCommand("mkfs.ext4 /dev/sdb1").ok).toBe(false);
  });

  it("escalates recursive s3 rm", () => {
    expect(checkCommand("aws s3 rm s3://bucket/path --recursive").ok).toBe(false);
  });
});

describe("denylist — safe operations pass", () => {
  it("allows normal git operations", () => {
    expect(checkCommand("git add .").ok).toBe(true);
    expect(checkCommand("git commit -m 'test'").ok).toBe(true);
    expect(checkCommand("git log").ok).toBe(true);
  });

  it("allows normal file operations", () => {
    expect(checkCommand("mkdir -p ~/repos/test").ok).toBe(true);
    expect(checkCommand("cp file.txt file.bak").ok).toBe(true);
    expect(checkCommand("mv old.txt new.txt").ok).toBe(true);
  });

  it("allows bun/npm commands", () => {
    expect(checkCommand("bun install").ok).toBe(true);
    expect(checkCommand("bun test").ok).toBe(true);
    expect(checkCommand("npm run build").ok).toBe(true);
  });
});
