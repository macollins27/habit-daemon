import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, type Migration } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";

/**
 * Migration 006 — habit_runs.last_escalation_message_id.
 *
 * Adds a single nullable TEXT column to habit_runs so the completion path
 * can post a follow-up that references the most-recent orphaned escalation
 * message. Additive only: no data migration, no breaking change, idempotent
 * via the migration runner's _migrations bookkeeping.
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

/** Apply only migrations 001..005 (the pre-006 baseline). */
async function applyPre006(db: Database.Database): Promise<void> {
  const all = loadMigrations();
  const pre006 = all.filter((m) => /^00[12345]_/.test(m.id));
  await runMigrations(db, pre006);
}

function findMigration006(): Migration {
  const all = loadMigrations();
  const m = all.find((mm) => mm.id.startsWith("006_"));
  if (m === undefined) {
    throw new Error(
      "migration 006 not found — load-migrations.ts must discover it from src/db/migrations/",
    );
  }
  return m;
}

describe("migration 006 — habit_runs.last_escalation_message_id", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    await applyPre006(db);
  });

  afterEach(() => {
    db.close();
  });

  it("adds last_escalation_message_id column to habit_runs as nullable TEXT", async () => {
    const m = findMigration006();
    await runMigrations(db, [m]);

    const cols = db
      .prepare("PRAGMA table_info(habit_runs)")
      .all() as ColumnInfo[];
    const col = cols.find((c) => c.name === "last_escalation_message_id");

    expect(col).toBeDefined();
    expect(col?.type.toUpperCase()).toBe("TEXT");
    // nullable: no NOT NULL constraint
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
    expect(col?.pk).toBe(0);
  });

  it("supports insert + read-back with NULL last_escalation_message_id", async () => {
    const m = findMigration006();
    await runMigrations(db, [m]);

    // Use the seed-habits channel ids set up by migration 001's foreign
    // key — but rather than wire seedHabits here, we satisfy the FK by
    // inserting a habits row directly.
    db.prepare(
      `INSERT INTO habits (
         id, name, domain, cron_expr, why_stakes_json, proof_type,
         proof_config_json, channel_id, active, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "test-habit",
      "Test",
      "row",
      "5 9 * * *",
      "{}",
      "concept2_api+photo_fallback",
      "{}",
      "1000000000000000001",
      1,
      1_700_000_000_000,
    );

    db.prepare(
      `INSERT INTO habit_runs (
         id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
         status, completed_at, proof_payload_json, skip_reason,
         proof_rejection_callout_due, last_escalation_message_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-null",
      "test-habit",
      "2026-05-13",
      1_700_000_000_000,
      1,
      null,
      "pending",
      null,
      null,
      null,
      0,
      null,
    );

    const row = db
      .prepare(
        "SELECT id, last_escalation_message_id FROM habit_runs WHERE id = ?",
      )
      .get("run-null") as
      | { readonly id: string; readonly last_escalation_message_id: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.last_escalation_message_id).toBeNull();
  });

  it("supports insert + read-back with a string last_escalation_message_id", async () => {
    const m = findMigration006();
    await runMigrations(db, [m]);

    db.prepare(
      `INSERT INTO habits (
         id, name, domain, cron_expr, why_stakes_json, proof_type,
         proof_config_json, channel_id, active, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "test-habit",
      "Test",
      "row",
      "5 9 * * *",
      "{}",
      "concept2_api+photo_fallback",
      "{}",
      "1000000000000000001",
      1,
      1_700_000_000_000,
    );

    db.prepare(
      `INSERT INTO habit_runs (
         id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
         status, completed_at, proof_payload_json, skip_reason,
         proof_rejection_callout_due, last_escalation_message_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-with-msg",
      "test-habit",
      "2026-05-13",
      1_700_000_000_000,
      2,
      null,
      "pending",
      null,
      null,
      null,
      0,
      "msg-abc-123",
    );

    const row = db
      .prepare(
        "SELECT last_escalation_message_id FROM habit_runs WHERE id = ?",
      )
      .get("run-with-msg") as
      | { readonly last_escalation_message_id: string | null }
      | undefined;
    expect(row?.last_escalation_message_id).toBe("msg-abc-123");
  });

  it("is idempotent — running through loadMigrations twice does not throw", async () => {
    // Running migrations is idempotent at the runner level: the _migrations
    // table records applied ids, so a second pass over the full list (which
    // includes 006) is a no-op for 006.
    const all = loadMigrations();
    await runMigrations(db, all);
    await expect(runMigrations(db, all)).resolves.not.toThrow();
  });

  it("preserves existing tables and data after applying 006", async () => {
    // Insert pre-006-baseline data (habits row).
    db.prepare(
      `INSERT INTO habits (
         id, name, domain, cron_expr, why_stakes_json, proof_type,
         proof_config_json, channel_id, active, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "pre-existing",
      "Pre",
      "row",
      "5 9 * * *",
      "{}",
      "concept2_api+photo_fallback",
      "{}",
      "1000000000000000001",
      1,
      1_700_000_000_000,
    );

    const m = findMigration006();
    await runMigrations(db, [m]);

    const row = db
      .prepare("SELECT id, name FROM habits WHERE id = ?")
      .get("pre-existing") as
      | { readonly id: string; readonly name: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe("Pre");

    // habit_runs table still exists with the new column.
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='habit_runs'",
      )
      .all() as NamedRow[];
    expect(tables).toHaveLength(1);
  });
});
