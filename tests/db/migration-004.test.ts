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

  it(
    "round-trips all 16 pre-existing event_type values through the rebuild " +
      "with id/prev_hash/written_iso/event_json/hash preserved",
    async () => {
      // Seed BEFORE migration 004 so the rebuild's INSERT...SELECT copy path
      // is exercised. The 16 values must come from migration 003 verbatim.
      const preExistingTypes = [
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

      db.prepare(
        `INSERT INTO sessions (session_id, created_iso, status) VALUES (?, ?, 'active')`,
      ).run("s-roundtrip", "2026-05-13T00:00:00Z");

      const insertEvent = db.prepare(
        `INSERT INTO session_events (
          session_id, seq, event_type, event_json, prev_hash, hash, trust_level, written_iso
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      interface SeedRow {
        readonly id: number;
        readonly event_type: string;
        readonly event_json: string;
        readonly prev_hash: string | null;
        readonly hash: string;
        readonly written_iso: string;
      }

      const seeded: SeedRow[] = [];
      for (const [i, t] of preExistingTypes.entries()) {
        const prevHash = i === 0 ? null : `prev-${String(i)}`;
        const hash = `hash-${String(i)}`;
        const writtenIso = `2026-05-13T00:00:${String(i).padStart(2, "0")}Z`;
        const eventJson = JSON.stringify({ idx: i, type: t });
        const info = insertEvent.run(
          "s-roundtrip",
          i,
          t,
          eventJson,
          prevHash,
          hash,
          "L1",
          writtenIso,
        );
        seeded.push({
          id: Number(info.lastInsertRowid),
          event_type: t,
          event_json: eventJson,
          prev_hash: prevHash,
          hash,
          written_iso: writtenIso,
        });
      }

      const m = findMigration004();
      await runMigrations(db, [m]);

      const after = db
        .prepare(
          `SELECT id, event_type, event_json, prev_hash, hash, written_iso
           FROM session_events
           WHERE session_id = 's-roundtrip'
           ORDER BY seq ASC`,
        )
        .all() as SeedRow[];

      expect(after).toHaveLength(16);

      const seenTypes = new Set<string>();
      for (const row of after) {
        seenTypes.add(row.event_type);
      }
      expect(seenTypes.size).toBe(16);
      for (const t of preExistingTypes) {
        expect(seenTypes.has(t)).toBe(true);
      }

      // Field-by-field preservation: each seeded row must round-trip with
      // id, prev_hash, written_iso, event_json, and hash unchanged.
      const afterById = new Map<number, SeedRow>();
      for (const row of after) {
        afterById.set(row.id, row);
      }
      for (const s of seeded) {
        const a = afterById.get(s.id);
        expect(a).toBeDefined();
        if (a === undefined) continue;
        expect(a.event_type).toBe(s.event_type);
        expect(a.event_json).toBe(s.event_json);
        expect(a.prev_hash).toBe(s.prev_hash);
        expect(a.hash).toBe(s.hash);
        expect(a.written_iso).toBe(s.written_iso);
      }
    },
  );

  it(
    "defer_foreign_keys path lets a ledger row's FK to session_events.id survive the rebuild",
    async () => {
      // Confirm connection-level FK enforcement is on; the migration relies on
      // PRAGMA defer_foreign_keys = ON to defer (not disable) checks.
      const fk = db.pragma("foreign_keys", { simple: true });
      expect(fk).toBe(1);

      // Create the ledger tables (runs, dispatches) — they are normally created
      // at runtime by Ledger.applyLedgerSchema(), not by a migration file.
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          run_id              TEXT PRIMARY KEY,
          verb                TEXT NOT NULL,
          args_json           TEXT NOT NULL,
          started_iso         TEXT NOT NULL,
          ended_iso           TEXT,
          status              TEXT NOT NULL
                              CHECK(status IN ('running','succeeded','failed','aborted','killed')),
          git_head_sha        TEXT NOT NULL,
          git_dirty           INTEGER NOT NULL CHECK(git_dirty IN (0,1)),
          cost_cap_usd        REAL,
          cost_actual_usd     REAL NOT NULL DEFAULT 0,
          killed_by           TEXT
        );

        CREATE TABLE IF NOT EXISTS dispatches (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id                  TEXT NOT NULL REFERENCES runs(run_id),
          session_id              TEXT REFERENCES sessions(session_id),
          skill                   TEXT NOT NULL,
          args                    TEXT NOT NULL,
          scope                   TEXT NOT NULL,
          authorized_paths_json   TEXT NOT NULL,
          model                   TEXT NOT NULL,
          dispatched_iso          TEXT NOT NULL,
          completed_iso           TEXT,
          artifact_path           TEXT,
          tool_uses               INTEGER,
          wall_clock_ms           INTEGER,
          cost_usd                REAL,
          write_set_json          TEXT,
          git_commit_sha_after    TEXT,
          git_dirty_files_json    TEXT,
          findings_status         TEXT
                                  CHECK(findings_status IN ('CLEAN','FINDINGS','FAILED','UNKNOWN')),
          root_cause              TEXT,
          evidence                TEXT,
          confidence              TEXT
                                  CHECK(confidence IN ('low','medium','high')),
          verified                INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
          verification_error      TEXT,
          hash_chain_record_id    INTEGER REFERENCES session_events(id)
        );
      `);

      // Seed a sessions parent row, a session_events row, then a ledger
      // dispatch whose hash_chain_record_id points at the session_event id.
      db.prepare(
        `INSERT INTO sessions (session_id, created_iso, status) VALUES (?, ?, 'active')`,
      ).run("s-fk", "2026-05-13T00:00:00Z");

      const eventInfo = db
        .prepare(
          `INSERT INTO session_events (
            session_id, seq, event_type, event_json, prev_hash, hash, trust_level, written_iso
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("s-fk", 0, "habit_completed", '{"a":1}', null, "h-fk", "L1", "2026-05-13T00:00:00Z");
      const eventId = Number(eventInfo.lastInsertRowid);
      expect(eventId).toBeGreaterThan(0);

      db.prepare(
        `INSERT INTO runs (run_id, verb, args_json, started_iso, status, git_head_sha, git_dirty)
         VALUES (?, ?, ?, ?, 'running', ?, 0)`,
      ).run("r-fk", "test", "{}", "2026-05-13T00:00:00Z", "deadbeef");

      const dispatchInfo = db
        .prepare(
          `INSERT INTO dispatches (
            run_id, skill, args, scope, authorized_paths_json, model,
            dispatched_iso, hash_chain_record_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("r-fk", "skill-x", "{}", "scope-x", "[]", "model-x", "2026-05-13T00:00:00Z", eventId);
      const dispatchId = Number(dispatchInfo.lastInsertRowid);

      // Verify the FK linkage is set up before migration.
      const preLink = db
        .prepare(`SELECT hash_chain_record_id FROM dispatches WHERE id = ?`)
        .get(dispatchId) as { readonly hash_chain_record_id: number | null };
      expect(preLink.hash_chain_record_id).toBe(eventId);

      // Run migration 004 — this drops and rebuilds session_events. If
      // defer_foreign_keys were to stop working, FK enforcement would fail
      // here because the dispatches row points at session_events(id).
      const m = findMigration004();
      await expect(runMigrations(db, [m])).resolves.not.toThrow();

      // Session event id must survive the rebuild verbatim.
      const eventAfter = db
        .prepare(
          `SELECT id, session_id, event_type, hash FROM session_events WHERE id = ?`,
        )
        .get(eventId) as
        | {
            readonly id: number;
            readonly session_id: string;
            readonly event_type: string;
            readonly hash: string;
          }
        | undefined;
      expect(eventAfter).toBeDefined();
      expect(eventAfter?.id).toBe(eventId);
      expect(eventAfter?.session_id).toBe("s-fk");
      expect(eventAfter?.event_type).toBe("habit_completed");
      expect(eventAfter?.hash).toBe("h-fk");

      // And the ledger row's FK still resolves to it via a JOIN.
      const joined = db
        .prepare(
          `SELECT d.id AS dispatch_id, e.id AS event_id, e.hash AS event_hash
           FROM dispatches d
           JOIN session_events e ON e.id = d.hash_chain_record_id
           WHERE d.id = ?`,
        )
        .get(dispatchId) as
        | {
            readonly dispatch_id: number;
            readonly event_id: number;
            readonly event_hash: string;
          }
        | undefined;
      expect(joined).toBeDefined();
      expect(joined?.dispatch_id).toBe(dispatchId);
      expect(joined?.event_id).toBe(eventId);
      expect(joined?.event_hash).toBe("h-fk");
    },
  );

  it("rejects an invalid event_type after the rebuild (CHECK still enforced)", async () => {
    const m = findMigration004();
    await runMigrations(db, [m]);

    db.prepare(
      `INSERT INTO sessions (session_id, created_iso, status) VALUES (?, ?, 'active')`,
    ).run("s-bad", "2026-05-13T00:00:00Z");

    const insert = db.prepare(
      `INSERT INTO session_events (
        session_id, seq, event_type, event_json, prev_hash, hash, trust_level, written_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    expect(() =>
      insert.run(
        "s-bad",
        0,
        "definitely_not_a_real_event_type",
        "{}",
        null,
        "h-bad",
        "L1",
        "2026-05-13T00:00:00Z",
      ),
    ).toThrowError(/CHECK constraint/i);
  });
});
