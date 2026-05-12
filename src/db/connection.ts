import Database from "better-sqlite3";

/**
 * Open a SQLite database at the given path and configure it for daemon use.
 *
 * - WAL journal mode: required for concurrent readers while the daemon writes.
 * - foreign_keys=ON: required because the habit-state schema relies on FK
 *   constraints (habit_runs -> habits, proof_stages -> habit_runs, etc.),
 *   which SQLite does NOT enforce by default.
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
