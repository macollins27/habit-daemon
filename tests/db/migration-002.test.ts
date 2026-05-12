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
  }
): void {
  db.prepare(
    `INSERT INTO habit_runs (
      id, habit_id, fire_date, fired_at, status
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(args.id, args.habitId, args.fireDate, Date.now(), "pending");
}

describe("migration 002 — miss_reasons, sensor_signals, plan_changes", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
  });

  it("creates all three tables", () => {
    expect(tableExists(db, "miss_reasons")).toBe(true);
    expect(tableExists(db, "sensor_signals")).toBe(true);
    expect(tableExists(db, "plan_changes")).toBe(true);
  });

  it("miss_reasons has the expected columns, types, and nullable flags", () => {
    const cols = tableInfo(db, "miss_reasons");
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.get("id")?.type).toBe("TEXT");
    expect(byName.get("id")?.pk).toBe(1);

    expect(byName.get("habit_id")?.notnull).toBe(1);
    expect(byName.get("run_id")?.notnull).toBe(1);
    expect(byName.get("miss_date")?.notnull).toBe(1);

    // Nullable by design — NULL when no_response classification, etc.
    expect(byName.get("user_response_text")?.notnull).toBe(0);
    expect(byName.get("classification")?.notnull).toBe(0);
    expect(byName.get("inferred_specifics")?.notnull).toBe(0);
    expect(byName.get("key_entities_json")?.notnull).toBe(0);
    expect(byName.get("classification_confidence")?.notnull).toBe(0);
    expect(byName.get("classification_confidence")?.type).toBe("REAL");
    expect(byName.get("gap_metadata_json")?.notnull).toBe(0);

    expect(byName.get("created_at")?.notnull).toBe(1);
    expect(byName.get("created_at")?.type).toBe("INTEGER");
  });

  it("sensor_signals has the expected columns and types", () => {
    const cols = tableInfo(db, "sensor_signals");
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("source")?.notnull).toBe(1);
    expect(byName.get("payload_date")?.notnull).toBe(1);
    expect(byName.get("payload_json")?.notnull).toBe(1);
    expect(byName.get("fetched_at")?.notnull).toBe(1);
    expect(byName.get("fetched_at")?.type).toBe("INTEGER");
  });

  it("plan_changes has the expected columns, types, and nullable cols", () => {
    const cols = tableInfo(db, "plan_changes");
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("proposal_id")?.notnull).toBe(1);
    expect(byName.get("habit_id")?.notnull).toBe(1);
    expect(byName.get("prior_config_json")?.notnull).toBe(1);
    expect(byName.get("new_config_json")?.notnull).toBe(1);
    expect(byName.get("applied_at")?.notnull).toBe(1);
    expect(byName.get("applied_at")?.type).toBe("INTEGER");

    // Nullable until a revert lands.
    expect(byName.get("reverted_at")?.notnull).toBe(0);
  });

  it("enforces miss_reasons.habit_id foreign key against habits", () => {
    insertHabit(db, "h1");
    insertRun(db, { id: "r1", habitId: "h1", fireDate: "2026-05-12" });

    expect(() =>
      db
        .prepare(
          `INSERT INTO miss_reasons (
            id, habit_id, run_id, miss_date, created_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run("mr-orphan", "does-not-exist", "r1", "2026-05-12", Date.now())
    ).toThrowError(/FOREIGN KEY/i);
  });

  it("enforces miss_reasons.run_id foreign key against habit_runs", () => {
    insertHabit(db, "h2");

    expect(() =>
      db
        .prepare(
          `INSERT INTO miss_reasons (
            id, habit_id, run_id, miss_date, created_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run("mr-orphan-run", "h2", "no-such-run", "2026-05-12", Date.now())
    ).toThrowError(/FOREIGN KEY/i);
  });

  it("enforces plan_changes.habit_id foreign key against habits", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO plan_changes (
            id, proposal_id, habit_id,
            prior_config_json, new_config_json, applied_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run("pc-orphan", "p1", "does-not-exist", "{}", "{}", Date.now())
    ).toThrowError(/FOREIGN KEY/i);
  });

  it("enforces UNIQUE(source, payload_date) on sensor_signals", () => {
    const insert = db.prepare(
      `INSERT INTO sensor_signals (
        id, source, payload_date, payload_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?)`
    );

    insert.run("s1", "garmin", "2026-05-12", "{}", Date.now());

    // Same (source, payload_date) collides.
    expect(() =>
      insert.run("s2", "garmin", "2026-05-12", "{}", Date.now())
    ).toThrowError(/UNIQUE/i);

    // Same source, different date is fine.
    expect(() =>
      insert.run("s3", "garmin", "2026-05-13", "{}", Date.now())
    ).not.toThrow();

    // Same date, different source is fine.
    expect(() =>
      insert.run("s4", "concept2", "2026-05-12", "{}", Date.now())
    ).not.toThrow();
  });

  it("accepts a valid row in each new table (positive control)", () => {
    insertHabit(db, "h3");
    insertRun(db, { id: "r3", habitId: "h3", fireDate: "2026-05-12" });

    expect(() =>
      db
        .prepare(
          `INSERT INTO miss_reasons (
            id, habit_id, run_id, miss_date,
            user_response_text, classification,
            inferred_specifics, key_entities_json,
            classification_confidence, gap_metadata_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "mr-ok",
          "h3",
          "r3",
          "2026-05-12",
          "was gaming until 2am",
          "gaming",
          "activity:gaming",
          "[]",
          0.92,
          "{}",
          Date.now()
        )
    ).not.toThrow();

    expect(() =>
      db
        .prepare(
          `INSERT INTO sensor_signals (
            id, source, payload_date, payload_json, fetched_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run("ss-ok", "garmin", "2026-05-11", "{}", Date.now())
    ).not.toThrow();

    expect(() =>
      db
        .prepare(
          `INSERT INTO plan_changes (
            id, proposal_id, habit_id,
            prior_config_json, new_config_json,
            applied_at, reverted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run("pc-ok", "prop-1", "h3", "{}", "{}", Date.now(), null)
    ).not.toThrow();
  });

  it("is idempotent — running loadMigrations() twice does not throw", async () => {
    await expect(runMigrations(db, loadMigrations())).resolves.not.toThrow();
    expect(tableExists(db, "miss_reasons")).toBe(true);
    expect(tableExists(db, "sensor_signals")).toBe(true);
    expect(tableExists(db, "plan_changes")).toBe(true);
  });
});
