import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";

describe("migration runner", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); });

  it("creates _migrations table on first run", async () => {
    await runMigrations(db, []);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'").get();
    expect(row).toBeDefined();
  });

  it("applies migrations in order and records them", async () => {
    await runMigrations(db, [
      { id: "001_test", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY)" },
    ]);
    const foo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo'").get();
    expect(foo).toBeDefined();
    const record = db.prepare("SELECT id FROM _migrations WHERE id='001_test'").get();
    expect(record).toBeDefined();
  });

  it("does not re-apply migrations", async () => {
    const migration = { id: "001_test", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY)" };
    await runMigrations(db, [migration]);
    // Second run must not throw "table foo already exists"
    await expect(runMigrations(db, [migration])).resolves.not.toThrow();
  });
});
