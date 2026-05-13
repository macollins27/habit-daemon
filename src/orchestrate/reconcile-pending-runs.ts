// Task 1.1: Reconcile pending habit runs against external sensor signals.
//
// This orchestrator closes habit_runs that are still in a pending state when
// the underlying sensor data (Concept2, Garmin) shows up after the daemon
// has already prompted (or stopped prompting) the user. Without it, the
// daemon nags the user after they have already completed the activity.
//
// Phase 1 wiring is layered across follow-up tasks:
//   - 1.2: Concept2 sync + run completion logic
//   - 1.3: Garmin sync + run completion logic
//   - 1.4: idempotency (skip already-resolved runs, no duplicate posts)
//   - 1.5: cron wiring (`*/2 * * * *`) and production integration
//
// This file is the skeleton: it pins the public surface (types + function
// signature) and returns zero counts. Real reconciliation logic ships next.

import type { SessionStore } from "../daemon/session-store.js";

export interface ReconcileResult {
  readonly attempted: number;
  readonly completed: number;
  readonly stillPending: number;
}

export interface ReconcileOptions {
  readonly sessionStore: SessionStore;
  readonly now: number;
  readonly concept2Sync: (opts: {
    habitId: string;
    runId: string;
    date: Date;
  }) => Promise<void>;
  readonly garminSync: (opts: {
    habitId: string;
    runId: string;
    date: Date;
  }) => Promise<void>;
  readonly postCompletion: (opts: {
    channelId: string;
    runId: string;
    summary: string;
  }) => Promise<void>;
}

export async function reconcilePendingRuns(
  _opts: ReconcileOptions,
): Promise<ReconcileResult> {
  return { attempted: 0, completed: 0, stillPending: 0 };
}
