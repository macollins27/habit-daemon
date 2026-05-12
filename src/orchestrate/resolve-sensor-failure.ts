// Task 15: orchestration verb for sensor failure → unresolved habit_run.
//
// Called by the sensor sync layer (Task 16 wires it up) when a Garmin fetch
// throws one of Garmin{AuthExpired,NetworkError,BridgeError} or a Concept2
// fetch fails after refresh. Effect:
//   1. habit_runs.status flips to 'unresolved' for the given run.
//   2. habit_runs.next_escalation_at is set to NULL — escalation halts until
//      a separate verb (Task 16's retry-unresolved-sensors) clears the row.
//   3. A 'sensor_failure_logged' event is appended to session_events at
//      trust_level L0 with payload {runId, source, error: {name, message}}.
//
// Both writes happen inside a single better-sqlite3 transaction; if the
// session-event append throws, the habit_runs UPDATE rolls back so the
// invariant "status='unresolved' implies sensor_failure_logged event"
// holds. better-sqlite3 supports nested transactions via SAVEPOINT, so the
// inner transaction inside SessionStore.append composes correctly.
//
// Connection invariant: the verb operates on `sessionStore.db` directly.
// SQLite WAL permits one writer at a time; passing a separate Database
// connection would deadlock on SQLITE_BUSY. To prevent that, the option
// interface no longer accepts `db` as a separate field — the verb derives
// it from `sessionStore.db` internally so callers cannot pass a wrong or
// separate handle.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 15
//   - src/db/migrations/001_habits.sql (habit_runs.status CHECK)
//   - src/daemon/session-store.ts (append(), L0 trust level rationale)

import type { SessionStore } from "../daemon/session-store.js";

export type SensorSource = "garmin" | "concept2";

export interface ResolveSensorFailureOptions {
  readonly sessionStore: SessionStore;
  readonly sessionId: string;
  readonly runId: string;
  readonly source: SensorSource;
  readonly error: Error;
}

interface SensorFailurePayload {
  readonly runId: string;
  readonly source: SensorSource;
  readonly error: {
    readonly name: string;
    readonly message: string;
  };
}

export function resolveSensorFailure(opts: ResolveSensorFailureOptions): void {
  const { sessionStore, sessionId, runId, source, error } = opts;
  const db = sessionStore.db;

  const payload: SensorFailurePayload = {
    runId,
    source,
    error: {
      name: error.name,
      message: error.message,
    },
  };

  const run = db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE habit_runs
           SET status = 'unresolved', next_escalation_at = NULL
         WHERE id = ?`,
      )
      .run(runId);

    if (result.changes === 0) {
      throw new Error(`habit_run not found: ${runId}`);
    }

    // L0: self-reported daemon event, no artifact or signed attestation.
    sessionStore.append(sessionId, "sensor_failure_logged", payload, {
      trustLevel: "L0",
    });
  });

  run();
}
