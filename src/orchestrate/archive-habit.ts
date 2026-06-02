/**
 * archiveHabit / unarchiveHabit — soft-delete a habit row by setting
 * `habits.archived_at` to an ISO timestamp (archive) or NULL (unarchive),
 * while toggling the `enabled` column on every `schedules` row that targets
 * this habit so the scheduler stops (resp. resumes) firing morning crons.
 *
 * Idempotency:
 *   - archiveHabit on an already-archived row is a no-op: no DB write, no
 *     audit event.
 *   - unarchiveHabit on an active (non-archived) row is a no-op: no DB
 *     write, no audit event.
 *   - These no-ops are silent — `unknown habit id` IS still an error
 *     (callers should know if their target doesn't exist), but
 *     "already in the target state" is not.
 *
 * Schedule linkage:
 *   Habit schedules are registered by `src/daemon/bootstrap.ts::registerHabitMorningCrons`
 *   with `verb = 'create-habit-run'` and `args_json = JSON.stringify({habitId})`.
 *   We match those rows by verb + a JSON-extract on `args_json.$.habitId`.
 *   This is the cleanest link (uses the structured JSON column rather than
 *   substring match on serialized text) and avoids touching schedules that
 *   happen to mention the habit id in some other context (e.g., a future
 *   habit-specific snooze verb whose args also embed habitId).
 *
 *   Future verbs that schedule habit work should follow the same convention
 *   (verb starts with a known prefix and args_json carries `habitId`) so
 *   this filter remains correct. If a new verb deviates, extend the WHERE
 *   clause here.
 *
 * Preserves `habit_runs`:
 *   We never touch `habit_runs`. Archiving is metadata-only — historical run
 *   data must remain queryable for retros, the wins poster, and pattern
 *   detection.
 *
 * Transactional: every state-mutating path runs in a single
 * better-sqlite3 transaction so the UPDATE, the schedule toggle, and the
 * audit event are atomic.
 */

import type { SessionStore } from "../daemon/session-store.js";

export interface ArchiveHabitOptions {
  readonly sessionStore: SessionStore;
  readonly id: string;
}

export interface UnarchiveHabitOptions {
  readonly sessionStore: SessionStore;
  readonly id: string;
}

interface HabitStateRow {
  readonly archived_at: string | null;
}

function loadHabitState(
  sessionStore: SessionStore,
  id: string,
): HabitStateRow {
  const row = sessionStore.db
    .prepare("SELECT archived_at FROM habits WHERE id = ?")
    .get(id) as HabitStateRow | undefined;
  if (row === undefined) {
    throw new Error(`unknown habit id: ${id}`);
  }
  return row;
}

export function archiveHabit(opts: ArchiveHabitOptions): void {
  const state = loadHabitState(opts.sessionStore, opts.id);
  if (state.archived_at !== null) {
    // Already archived — idempotent no-op. No DB write, no audit event.
    return;
  }

  const archivedAt = new Date().toISOString();
  const db = opts.sessionStore.db;

  const tx = db.transaction((): void => {
    db.prepare("UPDATE habits SET archived_at = ? WHERE id = ?").run(
      archivedAt,
      opts.id,
    );

    // Disable every habit-scoped schedule for this habit. See the file
    // header for the linkage convention (verb + args_json.$.habitId).
    db.prepare(
      `UPDATE schedules
       SET enabled = 0
       WHERE verb = 'create-habit-run'
         AND json_extract(args_json, '$.habitId') = ?`,
    ).run(opts.id);

    opts.sessionStore.append(
      "habit-mgmt",
      "habit_archived",
      { id: opts.id, archived_at: archivedAt },
      { trustLevel: "L1" },
    );
  });

  tx();
}

export function unarchiveHabit(opts: UnarchiveHabitOptions): void {
  const state = loadHabitState(opts.sessionStore, opts.id);
  if (state.archived_at === null) {
    // Not archived — idempotent no-op. No DB write, no audit event.
    return;
  }

  const db = opts.sessionStore.db;

  const tx = db.transaction((): void => {
    db.prepare("UPDATE habits SET archived_at = NULL WHERE id = ?").run(opts.id);

    db.prepare(
      `UPDATE schedules
       SET enabled = 1
       WHERE verb = 'create-habit-run'
         AND json_extract(args_json, '$.habitId') = ?`,
    ).run(opts.id);

    opts.sessionStore.append(
      "habit-mgmt",
      "habit_unarchived",
      { id: opts.id },
      { trustLevel: "L1" },
    );
  });

  tx();
}
