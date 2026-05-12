import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";

interface TableInfoRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

interface NameRow {
  readonly name: string;
}

function tableInfo(db: Database.Database, table: string): TableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
    )
    .get(table) as NameRow | undefined;
  return row !== undefined;
}

function insertHabit(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO habits (
      id, name, domain, cron_expr, why_stakes_json,
      proof_type, proof_config_json, channel_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    "test habit",
    "row",
    "0 6 * * *",
    "{}",
    "typed",
    "{}",
    "C0000001",
    Date.now()
  );
}

function insertRun(
  db: Database.Database,
  args: {
    readonly id: string;
    readonly habitId: string;
    readonly fireDate: string;
    readonly status?: string;
  }
): void {
  db.prepare(
    `INSERT INTO habit_runs (
      id, habit_id, fire_date, fired_at, status
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(
    args.id,
    args.habitId,
    args.fireDate,
    Date.now(),
    args.status ?? "pending"
  );
}

describe("migration 001 — habits, habit_runs, proof_stages", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
  });

  it("creates all three tables", () => {
    expect(tableExists(db, "habits")).toBe(true);
    expect(tableExists(db, "habit_runs")).toBe(true);
    expect(tableExists(db, "proof_stages")).toBe(true);
  });

  it("habits has the expected columns, types, and NOT NULL flags", () => {
    const cols = tableInfo(db, "habits");
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.get("id")?.type).toBe("TEXT");
    expect(byName.get("id")?.pk).toBe(1);

    expect(byName.get("name")?.notnull).toBe(1);
    expect(byName.get("domain")?.notnull).toBe(1);
    expect(byName.get("cron_expr")?.notnull).toBe(1);
    expect(byName.get("why_stakes_json")?.notnull).toBe(1);
    expect(byName.get("proof_type")?.notnull).toBe(1);
    expect(byName.get("proof_config_json")?.notnull).toBe(1);
    expect(byName.get("channel_id")?.notnull).toBe(1);

    expect(byName.get("active")?.notnull).toBe(1);
    expect(byName.get("active")?.dflt_value).toBe("1");

    expect(byName.get("created_at")?.notnull).toBe(1);
    expect(byName.get("created_at")?.type).toBe("INTEGER");
  });

  it("habit_runs has the expected columns, defaults, and nullable cols", () => {
    const cols = tableInfo(db, "habit_runs");
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("habit_id")?.notnull).toBe(1);
    expect(byName.get("fire_date")?.notnull).toBe(1);
    expect(byName.get("fired_at")?.notnull).toBe(1);

    expect(byName.get("current_level")?.notnull).toBe(1);
    expect(byName.get("current_level")?.dflt_value).toBe("1");

    // nullable until terminal status sets it
    expect(byName.get("next_escalation_at")?.notnull).toBe(0);

    expect(byName.get("status")?.notnull).toBe(1);

    expect(byName.get("completed_at")?.notnull).toBe(0);
    expect(byName.get("proof_payload_json")?.notnull).toBe(0);
    expect(byName.get("skip_reason")?.notnull).toBe(0);

    expect(byName.get("proof_rejection_callout_due")?.notnull).toBe(1);
    expect(byName.get("proof_rejection_callout_due")?.dflt_value).toBe("0");
  });

  it("proof_stages has the expected columns and defaults", () => {
    const cols = tableInfo(db, "proof_stages");
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("run_id")?.notnull).toBe(1);
    expect(byName.get("stage")?.notnull).toBe(1);

    expect(byName.get("satisfied")?.notnull).toBe(1);
    expect(byName.get("satisfied")?.dflt_value).toBe("0");

    expect(byName.get("satisfied_at")?.notnull).toBe(0);
    expect(byName.get("data_json")?.notnull).toBe(0);
  });

  it("enforces habit_runs.habit_id foreign key against habits", () => {
    expect(() =>
      insertRun(db, {
        id: "r-orphan",
        habitId: "does-not-exist",
        fireDate: "2026-05-12",
      })
    ).toThrowError(/FOREIGN KEY/i);
  });

  it("enforces proof_stages.run_id foreign key against habit_runs", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO proof_stages (id, run_id, stage) VALUES (?, ?, ?)"
        )
        .run("ps-orphan", "no-such-run", "a")
    ).toThrowError(/FOREIGN KEY/i);
  });

  it("enforces UNIQUE(habit_id, fire_date) on habit_runs", () => {
    insertHabit(db, "h1");
    insertRun(db, { id: "r1", habitId: "h1", fireDate: "2026-05-12" });

    expect(() =>
      insertRun(db, { id: "r2", habitId: "h1", fireDate: "2026-05-12" })
    ).toThrowError(/UNIQUE/i);

    // Different fire_date for same habit is fine.
    expect(() =>
      insertRun(db, { id: "r3", habitId: "h1", fireDate: "2026-05-13" })
    ).not.toThrow();
  });

  it("rejects invalid status via CHECK constraint", () => {
    insertHabit(db, "h2");

    expect(() =>
      insertRun(db, {
        id: "r-bad-status",
        habitId: "h2",
        fireDate: "2026-05-12",
        status: "bogus",
      })
    ).toThrowError(/CHECK/i);

    // Sanity: every allowed status inserts cleanly.
    const allowed = [
      "pending",
      "completed",
      "missed",
      "skipped",
      "partial",
      "unresolved",
      "unresolved_no_data",
    ];
    for (const [i, status] of allowed.entries()) {
      expect(() =>
        insertRun(db, {
          id: `r-ok-${i}`,
          habitId: "h2",
          fireDate: `2026-06-${String(i + 1).padStart(2, "0")}`,
          status,
        })
      ).not.toThrow();
    }
  });
});

describe("loadMigrations()", () => {
  it("returns at least migration 001 sorted by filename, with id stripped of .sql", () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(1);

    const ids = migrations.map((m) => m.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);

    const first = migrations[0];
    expect(first.id).toBe("001_habits");
    expect(first.id.endsWith(".sql")).toBe(false);
    expect(first.up).toContain("CREATE TABLE");
    expect(first.up).toContain("habits");
  });
});
