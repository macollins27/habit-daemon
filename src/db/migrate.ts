import type Database from "better-sqlite3";

export interface Migration {
  readonly id: string;
  readonly up: string;
}

/**
 * Apply migrations against the given SQLite database.
 *
 * Ensures a `_migrations(id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`
 * table exists, then applies any migration whose id is not yet recorded.
 * Each migration runs inside a transaction so a failure rolls back cleanly
 * and never leaves the schema half-applied.
 *
 * Idempotent: calling with the same migration list twice is a no-op the
 * second time.
 */
export async function runMigrations(
  db: Database.Database,
  migrations: ReadonlyArray<Migration>
): Promise<void> {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
  );

  const isApplied = db.prepare("SELECT 1 FROM _migrations WHERE id = ?");
  const recordApplied = db.prepare(
    "INSERT INTO _migrations (id, applied_at) VALUES (?, ?)"
  );

  for (const migration of migrations) {
    if (isApplied.get(migration.id)) {
      continue;
    }

    const apply = db.transaction((m: Migration) => {
      db.exec(m.up);
      recordApplied.run(m.id, Date.now());
    });

    apply(migration);
  }
}
