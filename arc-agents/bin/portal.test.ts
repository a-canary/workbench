import { describe, expect, it, beforeEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { unlinkSync, existsSync } from "node:fs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LEDGER = join(REPO, "bin", "ledger.ts");
const DB = "/tmp/portal-test.db";

function run(bin: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("bun", [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ARC_LEDGER_DB: DB },
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function ledger(args: string[]) {
  return run(LEDGER, args);
}

function initDb() {
  if (existsSync(DB)) unlinkSync(DB);
  ledger(["init"]);
}

// Insert a hitl prompt directly via DB (bypasses alive-module check).
function insertPrompt(prompt: string, opts: { priority?: number; recommended?: string; blocks?: string[]; repo?: string } = {}): string {
  const id = `hp-test-${Math.random().toString(36).slice(2, 10)}`;
  const payload = JSON.stringify({ prompt, options: [{ label: "a" }, { label: "b" }] });
  const blocksJson = opts.blocks ? JSON.stringify(opts.blocks) : null;
  const now = Math.floor(Date.now() / 1000);
  const bunScript = `
    import { Database } from "bun:sqlite";
    const db = new Database("${DB}");
    db.run(
      "INSERT INTO hitl_prompts (id, kind, class, payload, recommended, priority, default_action, blocks, state, anchor_repo, created_at) VALUES (?, 'ask_choice', 'taste', ?, ?, ?, ?, ?, 'open', ?, ?)",
      ["${id}", ${JSON.stringify(payload)}, ${JSON.stringify(opts.recommended ?? "a")}, ${opts.priority ?? 1}, ${JSON.stringify(opts.recommended ?? "a")}, ${JSON.stringify(blocksJson)}, ${JSON.stringify(opts.repo ?? null)}, ${now}]
    );
    db.close();
  `;
  spawnSync("bun", ["-e", bunScript], { encoding: "utf8" });
  return id;
}

// Insert with explicit default_action for portal field tests.
function insertPromptWithDefault(prompt: string, opts: { priority?: number; recommended?: string; blocks?: string[]; defaultAction?: string; repo?: string } = {}): string {
  const id = `hp-test-${Math.random().toString(36).slice(2, 10)}`;
  const payload = JSON.stringify({ prompt, options: [{ label: "a" }, { label: "b" }] });
  const blocksJson = opts.blocks ? JSON.stringify(opts.blocks) : null;
  const now = Math.floor(Date.now() / 1000);
  const bunScript = `
    import { Database } from "bun:sqlite";
    const db = new Database("${DB}");
    db.run(
      "INSERT INTO hitl_prompts (id, kind, class, payload, recommended, priority, default_action, blocks, state, anchor_repo, created_at) VALUES (?, 'ask_choice', 'taste', ?, ?, ?, ?, ?, 'open', ?, ?)",
      ["${id}", ${JSON.stringify(payload)}, ${JSON.stringify(opts.recommended ?? "a")}, ${opts.priority ?? 1}, ${JSON.stringify(opts.defaultAction ?? "apply default")}, ${JSON.stringify(blocksJson)}, ${JSON.stringify(opts.repo ?? null)}, ${now}]
    );
    db.close();
  `;
  spawnSync("bun", ["-e", bunScript], { encoding: "utf8" });
  return id;
}

beforeEach(() => {
  initDb();
});

describe("portal list", () => {
  it("returns empty when no prompts", () => {
    const r = ledger(["portal", "list"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out.trim());
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(0);
  });

  it("lists open prompts sorted by priority asc, age asc", () => {
    // Create prompts with different priorities.
    const id1 = insertPrompt("blocking question", { priority: 0, recommended: "a", blocks: ["i-1"] });
    const id2 = insertPrompt("advisory question", { priority: 1, recommended: "b" });
    // Small delay so timestamps differ.
    const id3 = insertPrompt("another blocking", { priority: 0, recommended: "c" });

    const r = ledger(["portal", "list"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out.trim());
    expect(rows.length).toBe(3);
    // Priority 0 first, then priority 1.
    expect(rows[0].priority).toBe(0);
    expect(rows[1].priority).toBe(0);
    expect(rows[2].priority).toBe(1);
    // Within priority 0, oldest first.
    expect(rows[0].id).toBe(id1);
    expect(rows[1].id).toBe(id3);
    expect(rows[2].id).toBe(id2);
  });

  it("filters by project", () => {
    const id1 = insertPrompt("proj a", { recommended: "a" });
    const bunScript = `
      import { Database } from "bun:sqlite";
      const db = new Database("${DB}");
      db.run("UPDATE hitl_prompts SET anchor_repo='arc-agents' WHERE id=?", ["${id1}"]);
      db.close();
    `;
    spawnSync("bun", ["-e", bunScript], { encoding: "utf8" });

    const r = ledger(["portal", "list", "--project", "arc-agents"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out.trim());
    expect(rows.length).toBe(1);
    expect(rows[0].project).toBe("arc-agents");
  });
});

describe("portal show", () => {
  it("shows full card for a prompt", () => {
    const id = insertPromptWithDefault("which approach?", {
      priority: 0,
      recommended: "oauth2",
      blocks: ["issue-1", "issue-2"],
    });
    const r = ledger(["portal", "show", id]);
    expect(r.code).toBe(0);
    const card = JSON.parse(r.out.trim());
    expect(card.id).toBe(id);
    expect(card.kind).toBe("ask_choice");
    expect(card.state).toBe("open");
    expect(card.priority).toBe(0);
    expect(card.recommended).toBe("oauth2");
    expect(card.default_action).toBe("apply default");
    expect(Array.isArray(card.blocks)).toBe(true);
    expect(card.blocks).toContain("issue-1");
    expect(card.blocks).toContain("issue-2");
    expect(card.question).toHaveProperty("prompt");
    expect(card.age_minutes).toBeGreaterThanOrEqual(0);
  });

  it("errors on unknown id", () => {
    const r = ledger(["portal", "show", "nonexistent"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no such hitl prompt");
  });
});

describe("portal answer", () => {
  it("answers a prompt and updates state", () => {
    const id = insertPrompt("pick one", { recommended: "a" });
    const r = ledger(["portal", "answer", id, "option-b"]);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out.trim());
    expect(result.id).toBe(id);
    expect(result.answer).toBe("option-b");
    expect(result.state).toBe("answered");

    // Verify state change.
    const show = ledger(["portal", "show", id]);
    const card = JSON.parse(show.out.trim());
    expect(card.state).toBe("answered");
  });

  it("writes note event on blocked issues", () => {
    const id = insertPrompt("pick one", { recommended: "a", blocks: ["issue-x"] });
    const r = ledger(["portal", "answer", id, "yes"]);
    expect(r.code).toBe(0);

    // Check that a note event was written.
    const bunScript = `
      import { Database } from "bun:sqlite";
      const db = new Database("${DB}");
      const rows = db.query("SELECT kind FROM issue_events WHERE issue_id='issue-x' AND kind='note'").all();
      console.log(JSON.stringify(rows.length));
      db.close();
    `;
    const ev = spawnSync("bun", ["-e", bunScript], { encoding: "utf8" });
    expect(parseInt(ev.stdout.trim(), 10)).toBe(1);
  });

  it("errors on already-answered prompt", () => {
    const id = insertPrompt("pick one", { recommended: "a" });
    ledger(["portal", "answer", id, "first"]);
    const r = ledger(["portal", "answer", id, "second"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot answer");
  });

  it("errors on unknown id", () => {
    const r = ledger(["portal", "answer", "nonexistent", "yes"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no such hitl prompt");
  });
});

describe("portal ack", () => {
  it("acknowledges an FYI prompt", () => {
    const id = insertPrompt("info only", { priority: 2, recommended: "a" });
    const r = ledger(["portal", "ack", id]);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out.trim());
    expect(result.id).toBe(id);
    expect(result.state).toBe("user_confirmed");

    // Verify it no longer appears in list.
    const list = ledger(["portal", "list"]);
    const rows = JSON.parse(list.out.trim());
    expect(rows.find((r: any) => r.id === id)).toBeUndefined();
  });

  it("errors on already-acked prompt", () => {
    const id = insertPrompt("info only", { priority: 2, recommended: "a" });
    ledger(["portal", "ack", id]);
    const r = ledger(["portal", "ack", id]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot ack");
  });
});

describe("portal error handling", () => {
  it("errors on unknown subverb", () => {
    const r = ledger(["portal", "bogus"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown portal verb");
  });
});
