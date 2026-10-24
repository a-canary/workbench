// SLA escalation for the attention portal (DESIGN.md §8).
//
// Scans hitl_prompts for overdue unanswered prompts and acts by priority:
//   priority 0 (blocking):  >60min  → note event on blocked issues + feedback row
//   priority 1 (advisory):  >24h    → auto-apply default_action (state='answered')
//   priority 2 (fyi):       >7d     → auto-ack (state='user_confirmed')
//
// Idempotent: only touches prompts still in state='open'.

import type { Database } from "bun:sqlite";
import { open } from "./db";
import { mintId } from "./db";

export const SLA_THRESHOLDS = {
  blocking: 60 * 60,       // 60 minutes
  advisory: 24 * 60 * 60,  // 24 hours
  fyi: 7 * 24 * 60 * 60,   // 7 days
};

export type EscalationResult = {
  escalated: number;
  autoAnswered: number;
  autoAcked: number;
  details: string[];
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function parseBlocks(blocks: string | null): string[] {
  if (!blocks) return [];
  try {
    const parsed = JSON.parse(blocks);
    return Array.isArray(parsed) ? parsed.filter((b): b is string => typeof b === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Escalate overdue open HITL prompts per SLA policy.
 * Pass a Database handle or a db path string.
 */
export function escalateOverduePrompts(dbArg: Database | string): EscalationResult {
  const db: Database = typeof dbArg === "string" ? open(dbArg) : dbArg;
  const closeOwn = typeof dbArg === "string";

  try {
    const result: EscalationResult = {
      escalated: 0,
      autoAnswered: 0,
      autoAcked: 0,
      details: [],
    };
    const now = nowSec();

    // priority 0: blocking, >60min — note on blocked issues + feedback row
    const blockingRows = db
      .query<{ id: string; created_at: number; blocks: string | null; project: string; kind: string; emitted_by: string | null }, [number]>(
        `SELECT id, created_at, blocks, emitted_by, kind FROM hitl_prompts
         WHERE state='open' AND priority=0
           AND created_at < ?`,
      )
      .all(now - SLA_THRESHOLDS.blocking);

    for (const row of blockingRows) {
      const ageMin = Math.floor((now - row.created_at) / 60);
      const blocks = parseBlocks(row.blocks);

      for (const issueId of blocks) {
        db.run(
          `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', ?, ?)`,
          [issueId, "sla-escalation", `HITL prompt ${row.id} is ${ageMin}min overdue (blocking)`],
        );
      }

      // feedback row (portal surface)
      const fbId = `fb-${mintId(db, `sla-blocking-${row.id}`)}`;
      db.run(
        `INSERT INTO feedback (id, project, source, body_md, context, origin_task_id, state)
         VALUES (?, ?, 'sla-escalation', ?, ?, ?, 'new')`,
        [
          fbId,
          "arc-agents",
          `SLA escalation: blocking HITL prompt ${row.id} (${row.kind}) is ${ageMin}min overdue${blocks.length ? `, blocking ${blocks.join(", ")}` : ""}`,
          `sla-blocking prompt=${row.id}`,
          null,
        ],
      );

      result.escalated++;
      result.details.push(`blocking ${row.id}: ${ageMin}min overdue, noted on ${blocks.length} issue(s) + feedback row ${fbId}`);
    }

    // priority 1: advisory, >24h — auto-apply default_action
    const advisoryRows = db
      .query<{ id: string; created_at: number; default_action: string | null }, [number]>(
        `SELECT id, created_at, default_action FROM hitl_prompts
         WHERE state='open' AND priority=1
           AND created_at < ?`,
      )
      .all(now - SLA_THRESHOLDS.advisory);

    for (const row of advisoryRows) {
      const ageH = Math.floor((now - row.created_at) / 3600);
      const answer = row.default_action ?? "";
      db.run(
        `UPDATE hitl_prompts SET state='answered', answer=?, answered_by='sla-auto', answered_at=? WHERE id=?`,
        [answer, now, row.id],
      );
      result.autoAnswered++;
      result.details.push(`advisory ${row.id}: ${ageH}h overdue, auto-answered with default: ${answer}`);
    }

    // priority 2: fyi, >7d — auto-ack
    const fyiRows = db
      .query<{ id: string; created_at: number }, [number]>(
        `SELECT id, created_at FROM hitl_prompts
         WHERE state='open' AND priority=2
           AND created_at < ?`,
      )
      .all(now - SLA_THRESHOLDS.fyi);

    for (const row of fyiRows) {
      const ageD = Math.floor((now - row.created_at) / 86400);
      db.run(`UPDATE hitl_prompts SET state='user_confirmed' WHERE id=?`, [row.id]);
      result.autoAcked++;
      result.details.push(`fyi ${row.id}: ${ageD}d overdue, auto-acked`);
    }

    return result;
  } finally {
    if (closeOwn) db.close();
  }
}
