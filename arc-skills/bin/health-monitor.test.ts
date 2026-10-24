#!/usr/bin/env bun
// Tests for health-monitor. Fixture db = the real feedback schema shape (the
// columns this script touches), so a schema drift that breaks the dedupe
// INSERT/DELETE fails here rather than in cron.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, runHealthMonitor, SERVICES, type Service } from "./health-monitor";

function fixtureDb(): Database {
  const db = new Database(":memory:");
  db.run(`create table feedback (
    id text primary key, project text, source text, submitter text,
    state text not null default 'new', body_md text not null, created_at integer,
    resolution text)`);
  return db;
}

const svc = (id: string, ok: boolean, detail?: string): Service => ({
  id,
  project: "test",
  probe: async () => {
    if (!ok) throw new Error(detail ?? "unreachable");
    return detail ?? "fine";
  },
});

function run(db: Database, services: Service[]) {
  const alerts: string[] = [];
  return runHealthMonitor({ db, services, notify: async (t) => void alerts.push(t), outDir: null, quiet: true }).then(
    (results) => ({ results, alerts }),
  );
}

const openRow = (db: Database, id: string) =>
  db.query<{ state: string; body_md: string }, [string]>("select state, body_md from feedback where id=?").get(id);

describe("health-monitor", () => {
  test("first failure writes one OPEN row and alerts once", async () => {
    const db = fixtureDb();
    const { alerts } = await run(db, [svc("alpha", false, "port 1 refused")]);
    expect(alerts).toEqual(["🔴 **alpha DOWN** — port 1 refused"]);
    expect(openRow(db, "hm-alpha")?.state).toBe("OPEN");
    expect(openRow(db, "hm-alpha")?.body_md).toContain("port 1 refused");
  });

  test("sustained outage does not re-alert", async () => {
    const db = fixtureDb();
    await run(db, [svc("alpha", false)]);
    const { alerts } = await run(db, [svc("alpha", false)]);
    expect(alerts).toEqual([]);
    expect(openRow(db, "hm-alpha")?.state).toBe("OPEN");
  });

  test("recovery resolves the row and alerts once, then stays quiet", async () => {
    const db = fixtureDb();
    await run(db, [svc("alpha", false)]);
    const up = await run(db, [svc("alpha", true, "back at :9999")]);
    expect(up.alerts).toEqual(["🟢 **alpha UP** — back at :9999"]);
    expect(openRow(db, "hm-alpha")?.state).toBe("resolved");
    expect(await run(db, [svc("alpha", true)])).toMatchObject({ alerts: [] });
  });

  test("a healthy service on first run files no row", async () => {
    const db = fixtureDb();
    const { alerts } = await run(db, [svc("alpha", true)]);
    expect(alerts).toEqual([]);
    expect(openRow(db, "hm-alpha")).toBeNull();
  });

  test("one failing check never hides the others", async () => {
    const db = fixtureDb();
    const { results, alerts } = await run(db, [
      svc("a", false, "boom"),
      svc("b", true),
      svc("c", false, "gone"),
    ]);
    expect(results.map((r) => r.ok)).toEqual([false, true, false]);
    expect(alerts.length).toBe(2);
  });

  test("alerts describe the transition, not the poll", async () => {
    const db = fixtureDb();
    const { alerts } = await run(db, [svc("alpha", false, "d1")]);
    expect(alerts[0]).not.toContain("tick");
    expect(alerts[0]).toContain("alpha DOWN");
  });

  test("real service list has unique ids and no probe throws unguarded", async () => {
    const ids = SERVICES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const db = fixtureDb();
    // Every real probe must settle (ok or thrown) — a hang means a broken timeout.
    const { results } = await run(db, SERVICES);
    expect(results.length).toBe(SERVICES.length);
  });
});
test("get retries once on a transient network error", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    if (++calls === 1) throw new Error("ECONNRESET");
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    expect((await get("http://x"))?.status).toBe(200);
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = real;
  }
});
