import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, type Migration } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";

/**
 * Migration 004 — chat and web UI schema additions.
 *
 * Spec adaptations (vs. plan as-written):
 *   - The plan's tests imported `applyMigration` and treated migration ids as
 *     numbers. The real API (src/db/migrate.ts) is `runMigrations(db, [m])`
 *     with `Migration.id: string` and the runner records applied ids in a
 *     `_migrations` table. We use the real API.
 *   - The plan asked us to "add habits.created_at with backfill". The actual
 *     001_habits.sql already declares `created_at INTEGER NOT NULL`. We do
 *     NOT re-add the column. Instead this test verifies the column already
 *     exists post-migration and that existing rows carry a value — which
 *     captures the intent ("existing rows have created_at") without
 *     duplicating an existing column.
 *   - session_events.event_type CHECK currently allows 16 values (see
 *     003_schedules_priority_and_events.sql). Migration 004 extends the
 *     CHECK to allow 6 additional chat / habit-CRUD event types, for a
 *     total of 22.
 */

interface ColumnInfo {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

interface NamedRow {
  readonly name: string;
}

/**
 * Apply only migrations 001..003 (the pre-004 baseline). Anchored by id
 * prefix so this stays correct if a later migration is renamed.
 */
async function applyPre004(db: Database.Database): Promise<void> {
  const all = loadMigrations();
  const pre004 = all.filter((m) => /^00[123]_/.test(m.id));
  await runMigrations(db, pre004);
}

function findMigration004(): Migration {
  const all = loadMigrations();
  const m = all.find((mm) => mm.id.startsWith("004_"));
  if (m === undefined) {
    throw new Error(
      "migration 004 not found — load-migrations.ts must discover it from src/db/migrations/",
    );
  }
  return m;
}

describe("migration 004 — chat and web UI", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    await applyPre004(db);
  });

  afterEach(() => {
    db.close();
  });

  it("adds habits.archived_at nullable column", async () => {
    const m = findMigration004();
    await runMigrations(db, [m]);
    const cols = db.prepare("PRAGMA table_info(habits)").all() as ColumnInfo[];
    const col = cols.find((c) => c.name === "archived_at");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
  });

  it("preserves habits.created_at — existing rows retain their value after migration", async () => {
    // habits.created_at is established by 001_habits.sql as INTEGER NOT NULL.
    // Migration 004 must not drop or null it for existing rows.
    const insert = db.prepare(
      `INSERT INTO habits (
        id, name, domain, cron_expr, why_stakes_json,
        proof_type, proof_config_json, channel_id, active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "h1",
      "Test habit",
      "row",
      "0 9 * * *",
      "{}",
      "concept2_or_photo",
      "{}",
      "c1",
      1,
      1_700_000_000_000,
    );

    const m = findMigration004();
    await runMigrations(db, [m]);

    const cols = db.prepare("PRAGMA table_info(habits)").all() as ColumnInfo[];
    const col = cols.find((c) => c.name === "created_at");
    expect(col).toBeDefined();

    const row = db
      .prepare("SELECT created_at FROM habits WHERE id = 'h1'")
      .get() as { readonly created_at: number | null };
    expect(row.created_at).toBe(1_700_000_000_000);
  });

  it("extends event_type CHECK constraint with 6 new chat / habit-CRUD values", async () => {
    const m = findMigration004();
    await runMigrations(db, [m]);

    // session_events FK references sessions(session_id); seed one row.
    db.prepare(
      `INSERT INTO sessions (session_id, created_iso, status) VALUES (?, ?, 'active')`,
    ).run("s1", "2026-05-13T00:00:00Z");

    const newTypes = [
      "user_message_received",
      "assistant_message_sent",
      "habit_created",
      "habit_updated",
      "habit_archived",
      "habit_unarchived",
    ] as const;

    const insert = db.prepare(
      `INSERT INTO session_events (
        session_id, seq, event_type, event_json, prev_hash, hash, trust_level, written_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const [i, t] of newTypes.entries()) {
      expect(() =>
        insert.run("s1", i, t, "{}", null, `h${String(i)}`, "L1", "2026-05-13T00:00:00Z"),
      ).not.toThrow();
    }
  });

  it("preserves all 16 pre-existing event_type values in the CHECK list", async () => {
    const m = findMigration004();
    await runMigrations(db, [m]);

    db.prepare(
      `INSERT INTO sessions (session_id, created_iso, status) VALUES (?, ?, 'active')`,
    ).run("s-old", "2026-05-13T00:00:00Z");

    const existing = [
      "habit_prompt_sent",
      "habit_user_response",
      "habit_proof_received",
      "habit_completed",
      "habit_missed",
      "habit_skip_requested",
      "habit_dodge_requested",
      "proof_attempt_rejected",
      "proposal_emitted",
      "proposal_applied",
      "proposal_rejected",
      "proposal_discussion_opened",
      "proposal_discussion_message",
      "proposal_resolved",
      "plan_change_applied",
      "sensor_failure_logged",
    ] as const;

    const insert = db.prepare(
      `INSERT INTO session_events (
        session_id, seq, event_type, event_json, prev_hash, hash, trust_level, written_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const [i, t] of existing.entries()) {
      expect(() =>
        insert.run("s-old", i, t, "{}", null, `h${String(i)}`, "L1", "2026-05-13T00:00:00Z"),
      ).not.toThrow();
    }
  });

  it("creates index on session_events(written_iso DESC)", async () => {
    const m = findMigration004();
    await runMigrations(db, [m]);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_events'",
      )
      .all() as NamedRow[];
    expect(idx.map((r) => r.name)).toContain("idx_session_events_written_iso_desc");
  });

  it("preserves the append-only triggers after rebuilding session_events", async () => {
    const m = findMigration004();
    await runMigrations(db, [m]);

    db.prepare(
      `INSERT INTO sessions (session_id, created_iso, status) VALUES (?, ?, 'active')`,
    ).run("s-trig", "2026-05-13T00:00:00Z");
    db.prepare(
      `INSERT INTO session_events (
        session_id, seq, event_type, event_json, prev_hash, hash, trust_level, written_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("s-trig", 0, "habit_completed", "{}", null, "h0", "L1", "2026-05-13T00:00:00Z");

    expect(() =>
      db.prepare("UPDATE session_events SET event_json = '{}' WHERE seq = 0").run(),
    ).toThrowError(/append-only/i);
    expect(() =>
      db.prepare("DELETE FROM session_events WHERE seq = 0").run(),
    ).toThrowError(/append-only/i);
  });

  it("preserves existing session_events rows across the table rebuild", async () => {
    db.prepare(
      `INSERT INTO sessions (session_id, created_iso, status) VALUES (?, ?, 'active')`,
    ).run("s-keep", "2026-05-13T00:00:00Z");
    db.prepare(
      `INSERT INTO session_events (
        session_id, seq, event_type, event_json, prev_hash, hash, trust_level, written_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("s-keep", 0, "habit_completed", "{\"a\":1}", null, "hkeep", "L1", "2026-05-13T00:00:00Z");

    const m = findMigration004();
    await runMigrations(db, [m]);

    const row = db
      .prepare(
        "SELECT session_id, seq, event_type, event_json, hash, trust_level FROM session_events WHERE session_id = 's-keep' AND seq = 0",
      )
      .get() as {
      readonly session_id: string;
      readonly seq: number;
      readonly event_type: string;
      readonly event_json: string;
      readonly hash: string;
      readonly trust_level: string;
    };
    expect(row).toBeDefined();
    expect(row.session_id).toBe("s-keep");
    expect(row.event_type).toBe("habit_completed");
    expect(row.event_json).toBe('{"a":1}');
    expect(row.hash).toBe("hkeep");
    expect(row.trust_level).toBe("L1");
  });

  it("is idempotent — running twice does not throw", async () => {
    const m = findMigration004();
    await runMigrations(db, [m]);
    await expect(runMigrations(db, [m])).resolves.not.toThrow();
  });
});
