import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, type Migration } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";

/**
 * Migration 005 — discord_channel_cursors.
 *
 * Adds a single new table tracking the last-observed Discord message
 * timestamp per channel. Used by the bootstrap catch-up sweep (Phase 5)
 * to replay any messages received while the daemon was restarting.
 *
 * The migration is additive only: it does not touch any existing table,
 * trigger, or index. Idempotency comes from the migration runner (each
 * id recorded in _migrations) plus CREATE TABLE IF NOT EXISTS for
 * runner-bypass safety.
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
 * Apply only migrations 001..004 (the pre-005 baseline). Anchored by id
 * prefix so this stays correct if a later migration is renamed.
 */
async function applyPre005(db: Database.Database): Promise<void> {
  const all = loadMigrations();
  const pre005 = all.filter((m) => /^00[1234]_/.test(m.id));
  await runMigrations(db, pre005);
}

function findMigration005(): Migration {
  const all = loadMigrations();
  const m = all.find((mm) => mm.id.startsWith("005_"));
  if (m === undefined) {
    throw new Error(
      "migration 005 not found — load-migrations.ts must discover it from src/db/migrations/",
    );
  }
  return m;
}

describe("migration 005 — discord_channel_cursors", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    await applyPre005(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates the discord_channel_cursors table", async () => {
    const m = findMigration005();
    await runMigrations(db, [m]);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='discord_channel_cursors'",
      )
      .all() as NamedRow[];
    expect(tables).toHaveLength(1);
  });

  it("defines (channel_id PK, last_seen_iso NOT NULL, updated_at NOT NULL)", async () => {
    const m = findMigration005();
    await runMigrations(db, [m]);

    const cols = db
      .prepare("PRAGMA table_info(discord_channel_cursors)")
      .all() as ColumnInfo[];

    const byName = new Map(cols.map((c) => [c.name, c] as const));
    const channelId = byName.get("channel_id");
    const lastSeenIso = byName.get("last_seen_iso");
    const updatedAt = byName.get("updated_at");

    expect(channelId).toBeDefined();
    expect(channelId?.pk).toBe(1);
    expect(channelId?.type.toUpperCase()).toBe("TEXT");

    expect(lastSeenIso).toBeDefined();
    expect(lastSeenIso?.notnull).toBe(1);
    expect(lastSeenIso?.type.toUpperCase()).toBe("TEXT");

    expect(updatedAt).toBeDefined();
    expect(updatedAt?.notnull).toBe(1);
    expect(updatedAt?.type.toUpperCase()).toBe("INTEGER");
  });

  it("supports insert and read-back of a cursor row", async () => {
    const m = findMigration005();
    await runMigrations(db, [m]);

    db.prepare(
      `INSERT INTO discord_channel_cursors (channel_id, last_seen_iso, updated_at)
       VALUES (?, ?, ?)`,
    ).run("1000000000000000001", "2026-05-13T10:00:00.000Z", 1_700_000_000_000);

    const row = db
      .prepare(
        "SELECT channel_id, last_seen_iso, updated_at FROM discord_channel_cursors WHERE channel_id = ?",
      )
      .get("1000000000000000001") as
      | {
          readonly channel_id: string;
          readonly last_seen_iso: string;
          readonly updated_at: number;
        }
      | undefined;

    expect(row).toBeDefined();
    expect(row?.channel_id).toBe("1000000000000000001");
    expect(row?.last_seen_iso).toBe("2026-05-13T10:00:00.000Z");
    expect(row?.updated_at).toBe(1_700_000_000_000);
  });

  it("enforces channel_id PRIMARY KEY uniqueness", async () => {
    const m = findMigration005();
    await runMigrations(db, [m]);

    db.prepare(
      `INSERT INTO discord_channel_cursors (channel_id, last_seen_iso, updated_at)
       VALUES (?, ?, ?)`,
    ).run("c1", "2026-05-13T10:00:00.000Z", 1_700_000_000_000);

    expect(() =>
      db
        .prepare(
          `INSERT INTO discord_channel_cursors (channel_id, last_seen_iso, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run("c1", "2026-05-13T11:00:00.000Z", 1_700_000_000_001),
    ).toThrowError(/UNIQUE constraint|PRIMARY KEY/i);
  });

  it("is idempotent — running twice does not throw", async () => {
    const m = findMigration005();
    await runMigrations(db, [m]);
    await expect(runMigrations(db, [m])).resolves.not.toThrow();
  });
});
