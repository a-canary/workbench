import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { loadConfig } from "./ux-config";
import { insertHitlPrompt } from "./hitl-prompt";
import { escalateOverduePrompts } from "./hitl-sla";

const FULL_CFG = `
modules:
  arc-tui:
    cli: arc-tui
    implements: [ask_text, ask_choice, ask_confirm, notify, show_artifact]
    renders:
      text/markdown: native
      text/diff: native
      image/png: ascii-degrade
      chart/vega-lite: ascii-degrade
      diagram/mermaid: ascii-degrade
      table/rows: native
    can_retract: true
`;

let dir: string;
let dbPath: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hitl-sla-"));
  dbPath = join(dir, "t.db");
  cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, FULL_CFG);
  const db = new Database(dbPath);
  migrate(db);
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): Database {
  return new Database(dbPath);
}

function heartbeat(db: Database, name: string): void {
  db.run(
    `INSERT INTO ux_heartbeats (module_name, last_beat) VALUES (?, strftime('%s','now'))
     ON CONFLICT(module_name) DO UPDATE SET last_beat=excluded.last_beat`,
    [name],
  );
}

function seedPrompt(db: Database, overrides: { priority?: 0 | 1 | 2; defaultAction?: string | null; blocks?: string[] | null } = {}) {
  const id = `test-${Math.random().toString(36).slice(2, 10)}`;
  heartbeat(db, "arc-tui");
  const result = insertHitlPrompt(db, {
    id,
    kind: "ask_choice",
    cls: "taste",
    payload: { prompt: "test?", options: ["a", "b"] },
    recommended: "a",
    strategy: null,
    timeoutSec: null,
    emittedBy: "test-worker",
    priority: overrides.priority ?? 1,
    defaultAction: overrides.defaultAction ?? null,
    blocks: overrides.blocks ?? null,
    cfg: loadConfig(cfgPath),
  });
  return result.id;
}

describe("hitl-sla escalation", () => {
  test("escalates blocking prompt >60min: note on blocked issues + feedback row", () => {
    const db = openDb();
    db.run("INSERT INTO issues (id, project, title, body_md, type, kind, state) VALUES ('issue-1', 'test', 'test issue', '', 'interactive', 'task', 'blocked')");
    const id = seedPrompt(db, { priority: 0, blocks: ["issue-1"] });
    const age = Math.floor(Date.now() / 1000) - 90 * 60;
    db.run("UPDATE hitl_prompts SET created_at = ? WHERE id = ?", [age, id]);

    const sla = escalateOverduePrompts(db);

    expect(sla.escalated).toBe(1);
    const note = db.query("SELECT * FROM issue_events WHERE issue_id='issue-1' AND agent='sla-escalation'").get();
    expect(note).not.toBeNull();
    expect(note.payload_md).toContain("overdue");
    const fb = db.query("SELECT * FROM feedback WHERE source='sla-escalation'").get();
    expect(fb).not.toBeNull();
    expect(fb.body_md).toContain("blocking");
    db.close();
  });

  test("auto-answers advisory prompt >24h with default_action", () => {
    const db = openDb();
    const id = seedPrompt(db, { priority: 1, defaultAction: "apply-default" });
    const age = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    db.run("UPDATE hitl_prompts SET created_at = ? WHERE id = ?", [age, id]);
    const sla = escalateOverduePrompts(db);

    expect(sla.autoAnswered).toBe(1);
    const row = db.query("SELECT * FROM hitl_prompts WHERE id = ?").get(id);
    expect(row.state).toBe("answered");
    expect(row.answer).toBe("apply-default");
    expect(row.answered_by).toBe("sla-auto");
    db.close();
  });

  test("auto-acks fyi prompt >7d", () => {
    const db = openDb();
    const id = seedPrompt(db, { priority: 2 });
    const age = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;
    db.run("UPDATE hitl_prompts SET created_at = ? WHERE id = ?", [age, id]);

    const sla = escalateOverduePrompts(db);

    expect(sla.autoAcked).toBe(1);
    const row = db.query("SELECT * FROM hitl_prompts WHERE id = ?").get(id);
    expect(row.state).toBe("user_confirmed");
    db.close();
  });

  test("does not escalate fresh prompts", () => {
    const db = openDb();
    seedPrompt(db, { priority: 0 });
    seedPrompt(db, { priority: 1, defaultAction: "default" });
    seedPrompt(db, { priority: 2 });

    const sla = escalateOverduePrompts(db);

    expect(sla.escalated).toBe(0);
    expect(sla.autoAnswered).toBe(0);
    expect(sla.autoAcked).toBe(0);
    db.close();
  });

  test("is idempotent: already-answered prompts are skipped", () => {
    const db = openDb();
    const id = seedPrompt(db, { priority: 1, defaultAction: "default" });
    const age = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    db.run("UPDATE hitl_prompts SET created_at = ? WHERE id = ?", [age, id]);

    const sla1 = escalateOverduePrompts(db);
    expect(sla1.autoAnswered).toBe(1);

    const sla2 = escalateOverduePrompts(db);
    expect(sla2.autoAnswered).toBe(0);
    db.close();
  });
});
