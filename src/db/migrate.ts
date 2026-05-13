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
 * Foreign-key handling:
 *   `PRAGMA foreign_keys` is a no-op while a transaction is open, and
 *   `PRAGMA defer_foreign_keys` does NOT defer the FK check fired by
 *   `ALTER TABLE ... RENAME` at COMMIT (that check runs eagerly). To let
 *   table-rebuild migrations swap referenced tables safely, the runner
 *   disables FK enforcement BEFORE entering each migration's transaction,
 *   runs the migration, then verifies integrity with `PRAGMA foreign_key_check`
 *   after commit. Any violations introduced by the migration are reported
 *   as an error (fail-closed). FK state is always restored in a `finally`
 *   block, even if the migration throws.
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

    const prevFk = db.pragma("foreign_keys", { simple: true });
    db.pragma("foreign_keys = OFF");
    try {
      const apply = db.transaction((m: Migration) => {
        db.exec(m.up);
      });

      apply(migration);

      const violations = db.pragma("foreign_key_check") as ReadonlyArray<unknown>;
      if (violations.length > 0) {
        throw new Error(
          `migration ${migration.id} introduced FK violations: ${JSON.stringify(violations)}`
        );
      }

      recordApplied.run(migration.id, Date.now());
    } finally {
      db.pragma(prevFk ? "foreign_keys = ON" : "foreign_keys = OFF");
    }
  }
}
