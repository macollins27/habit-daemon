// AgentManager-pattern kill switch (R7 lift, GCS→SQLite substrate swap).
// Kill verb writes a kind="kill-request" actions row; orchestrator dispatch
// loops poll isKillRequested between dispatches.
//
// v0.1 ships the read/write primitive. v0.2+ wires the poll into the
// remediate dispatch loop so a a kill command from another terminal
// stops the in-flight dispatch at the next checkpoint.
//
// References:
//   - R7 finding: 2026-05-02_agentmanager-autobeat-deep-dive.md (kill-switch lift)

import { Ledger } from "./ledger.js";

export interface KillCheckResult {
  readonly killed: boolean;
  readonly killedBy: string | null;
  readonly killedAt: string | null;
}

/**
 * Record a kill request for a run. Writes a kind="kill-request" actions row.
 * Idempotent: subsequent calls record additional rows but isKillRequested
 * only reads the FIRST one.
 */
export function setKillRequest(ledger: Ledger, runId: string, requestedBy: string): void {
  ledger.writeAction({
    runId,
    dispatchId: null,
    kind: "kill-request",
    payloadJson: JSON.stringify({
      requested_by: requestedBy,
      requested_iso: new Date().toISOString(),
    }),
  });
}

/**
 * Check whether a kill request has been recorded for this run.
 * Returns the first kill-request row's metadata if any exists.
 */
export function isKillRequested(ledger: Ledger, runId: string): KillCheckResult {
  const row = ledger.sessionStore.db
    .prepare(
      `SELECT created_iso, payload_json FROM actions
       WHERE run_id = ? AND kind = 'kill-request'
       ORDER BY id ASC LIMIT 1`,
    )
    .get(runId) as { created_iso: string; payload_json: string } | undefined;

  if (row === undefined) {
    return { killed: false, killedBy: null, killedAt: null };
  }

  let requestedBy: string | null = null;
  try {
    const payload = JSON.parse(row.payload_json) as { requested_by?: unknown };
    if (typeof payload.requested_by === "string") {
      requestedBy = payload.requested_by;
    }
  } catch {
    requestedBy = null;
  }

  return {
    killed: true,
    killedBy: requestedBy,
    killedAt: row.created_iso,
  };
}
