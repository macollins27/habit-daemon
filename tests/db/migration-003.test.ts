import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { Ledger } from "../../src/daemon/ledger.js";
import {
  SessionStore,
  type SessionEventType,
} from "../../src/daemon/session-store.js";

// All 16 event_type values permitted by the CHECK constraint.
// 15 from design doc § 2 (session_events extension list) plus
// 'sensor_failure_logged' from plan Task 15.
const ALL_EVENT_TYPES: readonly SessionEventType[] = [
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
];

interface TableInfoRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

interface MasterSqlRow {
  readonly sql: string;
}

function tableInfo(db: Database.Database, table: string): TableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
}

function getCreateSql(db: Database.Database, table: string): string {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?",
    )
    .get(table) as MasterSqlRow | undefined;
  if (row === undefined) {
    throw new Error(`table ${table} does not exist`);
  }
  return row.sql;
}

interface NamedSqlRow {
  readonly name: string;
  readonly sql: string;
}

interface TableSnapshot {
  readonly columns: readonly TableInfoRow[];
  readonly sql: string;
}

interface SchemaSnapshot {
  readonly tables: Readonly<Record<string, TableSnapshot>>;
  readonly indexes: readonly NamedSqlRow[];
  readonly triggers: readonly NamedSqlRow[];
}

// Tables compared by the in-both-orders test. session_events and schedules
// are the tables migration 003 touches; sessions is the FK target and is
// owned by SessionStore.applySchema, so we compare it too to catch drift.
const TRACKED_TABLES: readonly string[] = ["sessions", "schedules", "session_events"];

/**
 * Collapse whitespace in a SQL string so the in-both-orders comparison
 * matches on semantics, not on indentation/line-break style. SQLite stores
 * the verbatim CREATE-statement text in `sqlite_master.sql`; the migration-
 * 003 SQL file uses 2-space column indentation while `SessionStore.applySchema`
 * and `Ledger.applyLedgerSchema` build their DDL inside a template literal
 * at 8-space indentation. Both are semantically identical SQL — a strict
 * `toEqual` on the raw `sql` would flag the whitespace as drift.
 */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function normalizeNamedSql(row: NamedSqlRow): NamedSqlRow {
  return { name: row.name, sql: normalizeSql(row.sql) };
}

function captureSchema(dbPath: string): SchemaSnapshot {
  const db = openDatabase(dbPath);
  try {
    const tables: Record<string, TableSnapshot> = {};
    for (const t of TRACKED_TABLES) {
      tables[t] = {
        columns: tableInfo(db, t),
        sql: normalizeSql(getCreateSql(db, t)),
      };
    }

    // Filter: `sql IS NOT NULL` drops SQLite's auto-created PRIMARY KEY /
    // UNIQUE indexes (sqlite_autoindex_*), which carry no explicit DDL and
    // should not be part of the drift comparison.
    const placeholders = TRACKED_TABLES.map(() => "?").join(",");
    const indexes = (
      db
        .prepare(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'index'
             AND tbl_name IN (${placeholders})
             AND sql IS NOT NULL
           ORDER BY name`,
        )
        .all(...TRACKED_TABLES) as NamedSqlRow[]
    ).map(normalizeNamedSql);
    const triggers = (
      db
        .prepare(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'trigger'
             AND tbl_name IN (${placeholders})
             AND sql IS NOT NULL
           ORDER BY name`,
        )
        .all(...TRACKED_TABLES) as NamedSqlRow[]
    ).map(normalizeNamedSql);

    return { tables, indexes, triggers };
  } finally {
    db.close();
  }
}

describe("migration 003 — schedules.dispatch_priority + session_events.event_type", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-mig-003-test-"));
    dbPath = join(tempDir, "test.db");
    db = openDatabase(dbPath);
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("schedules has dispatch_priority column with default 100", () => {
    const cols = tableInfo(db, "schedules");
    const byName = new Map(cols.map((c) => [c.name, c]));

    const col = byName.get("dispatch_priority");
    expect(col).toBeDefined();
    expect(col?.type).toBe("INTEGER");
    expect(col?.notnull).toBe(1);
    expect(col?.dflt_value).toBe("100");
  });

  it("session_events has event_type column (nullable, with CHECK)", () => {
    const cols = tableInfo(db, "session_events");
    const byName = new Map(cols.map((c) => [c.name, c]));

    const col = byName.get("event_type");
    expect(col).toBeDefined();
    expect(col?.type).toBe("TEXT");
    // Nullable in the column declaration; CHECK is "NULL OR IN (...)".
    expect(col?.notnull).toBe(0);
  });

  it("session_events CHECK lists all 16 event_type values", () => {
    const sql = getCreateSql(db, "session_events");
    for (const t of ALL_EVENT_TYPES) {
      expect(sql).toContain(t);
    }
  });

  it("accepts every one of the 16 allowed event_type values", () => {
    const insert = db.prepare(
      `INSERT INTO session_events (
        session_id, seq, event_json, prev_hash, hash, trust_level, event_type, written_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.prepare(
      `INSERT INTO sessions (session_id, created_iso, status) VALUES (?, ?, 'active')`,
    ).run("s-ok", new Date().toISOString());

    for (const [i, t] of ALL_EVENT_TYPES.entries()) {
      expect(() =>
        insert.run("s-ok", i, "{}", null, `h${String(i)}`, "L1", t, new Date().toISOString()),
      ).not.toThrow();
    }
  });

  it("rejects a bogus event_type via CHECK", () => {
    db.prepare(
      `INSERT INTO sessions (session_id, created_iso, status) VALUES (?, ?, 'active')`,
    ).run("s-bad", new Date().toISOString());

    expect(() =>
      db
        .prepare(
          `INSERT INTO session_events (
            session_id, seq, event_json, prev_hash, hash, trust_level, event_type, written_iso
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("s-bad", 0, "{}", null, "h0", "L1", "bogus_type", new Date().toISOString()),
    ).toThrowError(/CHECK/i);
  });

  it("accepts NULL event_type via CHECK", () => {
    db.prepare(
      `INSERT INTO sessions (session_id, created_iso, status) VALUES (?, ?, 'active')`,
    ).run("s-null", new Date().toISOString());

    expect(() =>
      db
        .prepare(
          `INSERT INTO session_events (
            session_id, seq, event_json, prev_hash, hash, trust_level, event_type, written_iso
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("s-null", 0, "{}", null, "h0", "L1", null, new Date().toISOString()),
    ).not.toThrow();
  });

  it("accepts an insert that omits event_type entirely (NULL default)", () => {
    db.prepare(
      `INSERT INTO sessions (session_id, created_iso, status) VALUES (?, ?, 'active')`,
    ).run("s-default", new Date().toISOString());

    expect(() =>
      db
        .prepare(
          `INSERT INTO session_events (
            session_id, seq, event_json, prev_hash, hash, trust_level, written_iso
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("s-default", 0, "{}", null, "h0", "L1", new Date().toISOString()),
    ).not.toThrow();
  });

  it("is idempotent on re-runs", async () => {
    await expect(runMigrations(db, loadMigrations())).resolves.not.toThrow();
    expect(tableInfo(db, "schedules").some((c) => c.name === "dispatch_priority")).toBe(true);
    expect(tableInfo(db, "session_events").some((c) => c.name === "event_type")).toBe(true);
  });
});

describe("migration 003 — SessionStore.append round-trip with event_type", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-mig-003-store-"));
    storePath = join(tempDir, "store.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("append() writes event_type and load() returns it", () => {
    const store = new SessionStore({ dbPath: storePath });
    try {
      store.createSession("s1");
      const id = store.append("s1", "habit_completed", { ok: true }, { trustLevel: "L1" });
      expect(id).toBeGreaterThan(0);

      const rows = store.load("s1");
      expect(rows.length).toBe(1);
      const row = rows[0];
      // load() now projects event_type via the eventType field on the row.
      expect(row.eventType).toBe("habit_completed");
      // Existing AatRecord fields still populated.
      expect(row.hash).toBeTruthy();
      expect(row.trustLevel).toBe("L1");
    } finally {
      store.close();
    }
  });

  it("append() with an invalid event_type (TS-bypassed) is rejected by CHECK", () => {
    const store = new SessionStore({ dbPath: storePath });
    try {
      store.createSession("s-bad");
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store.append("s-bad", "not_a_real_event" as unknown as SessionEventType, {}, {
          trustLevel: "L1",
        }),
      ).toThrowError(/CHECK/i);
    } finally {
      store.close();
    }
  });
});

describe("migration 003 — in-both-orders idempotence", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-mig-003-order-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Order 1 (Ledger-first) produces identical schema to Order 2 (migrations-first)", async () => {
    // Order 1: Ledger first (which constructs SessionStore + runs both
    // applySchema calls), then migrations on the same file.
    const orderAPath = join(tempDir, "a.db");
    const ledgerA = new Ledger({ dbPath: orderAPath });
    const dbA = openDatabase(orderAPath);
    await runMigrations(dbA, loadMigrations());
    dbA.close();
    ledgerA.close();
    const orderASchema = captureSchema(orderAPath);

    // Order 2: migrations first on an empty DB, then construct Ledger
    // (whose CREATE TABLE IF NOT EXISTS calls become no-ops).
    const orderBPath = join(tempDir, "b.db");
    const dbB = openDatabase(orderBPath);
    await runMigrations(dbB, loadMigrations());
    dbB.close();
    const ledgerB = new Ledger({ dbPath: orderBPath });
    ledgerB.close();
    const orderBSchema = captureSchema(orderBPath);

    // Full-snapshot equality across both orderings: tables (columns + DDL),
    // explicitly-named indexes, and triggers. Any drift between
    // SessionStore.applySchema / Ledger.applyLedgerSchema and migration 003
    // is caught here, regardless of which artifact (column, index, trigger)
    // drifted.
    expect(orderASchema).toEqual(orderBSchema);

    // Sanity checks on the shared snapshot content. These guard against the
    // (unlikely) case where both orders converge on an *incorrect* schema.
    for (const t of ALL_EVENT_TYPES) {
      expect(orderASchema.tables.session_events.sql).toContain(t);
    }
    expect(orderASchema.tables.schedules.sql).toContain("dispatch_priority");
  });

  it("Order 1 end state allows SessionStore.append with a valid event_type", () => {
    const dbPath = join(tempDir, "order1.db");
    const ledger = new Ledger({ dbPath });
    try {
      ledger.sessionStore.createSession("s-a");
      const id = ledger.sessionStore.append(
        "s-a",
        "proposal_emitted",
        { foo: "bar" },
        { trustLevel: "L1" },
      );
      expect(id).toBeGreaterThan(0);
    } finally {
      ledger.close();
    }
  });

  it("Order 2 end state allows SessionStore.append with a valid event_type", async () => {
    const dbPath = join(tempDir, "order2.db");
    const db = openDatabase(dbPath);
    await runMigrations(db, loadMigrations());
    db.close();
    const ledger = new Ledger({ dbPath });
    try {
      ledger.sessionStore.createSession("s-b");
      const id = ledger.sessionStore.append(
        "s-b",
        "habit_prompt_sent",
        { foo: "bar" },
        { trustLevel: "L1" },
      );
      expect(id).toBeGreaterThan(0);
    } finally {
      ledger.close();
    }
  });
});

describe("migration 003 — type export sanity", () => {
  it("SessionEventType type-level allows all 16 string-literal values", () => {
    // Compile-time check: the const array's element type must be assignable
    // to SessionEventType (this fails the typecheck if a value is missing).
    const sample: readonly SessionEventType[] = ALL_EVENT_TYPES;
    expect(sample.length).toBe(16);
  });
});
