// The single most important regression guard from the 2026 outage.
//
// One account-wide billing failure was charged to 135 individual runs, eight
// times each, until every one of them was permanently parked. The rule this
// test defends: when the failure is account-wide, a habit run loses NOTHING —
// not a retry attempt, not its schedule, not its level.

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { diagnosticFromDispatchError } from "../../src/daemon/scheduler.js";
import {
  evaluateDispatchGate,
  isGlobalOutage,
  pauseAiDependency,
} from "../../src/daemon/ai-dependency.js";
import { formatDiagnostic, summariseDispatch } from "../../src/daemon/dispatch-diagnostics.js";

const SCHEMA = `
CREATE TABLE ai_dependency_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('healthy','paused')),
  category TEXT, detail TEXT, auth_mode TEXT,
  paused_at INTEGER, last_probe_at INTEGER, next_probe_at INTEGER,
  probe_count INTEGER NOT NULL DEFAULT 0, alert_sent_at INTEGER,
  updated_at INTEGER NOT NULL
);
INSERT INTO ai_dependency_state (id,state,probe_count,updated_at) VALUES (1,'healthy',0,0);
CREATE TABLE habit_runs (
  id TEXT PRIMARY KEY, status TEXT, current_level INTEGER,
  next_escalation_at INTEGER, escalation_failure_count INTEGER DEFAULT 0,
  last_dispatch_error TEXT
);
INSERT INTO habit_runs VALUES ('run-1','pending',1,1000,0,NULL);
`;

/** The exact envelope the production failure produced, end to end. */
const CREDIT_ENVELOPE = JSON.stringify({
  is_error: true,
  terminal_reason: "api_error",
  api_error_status: 400,
  result: "Credit balance is too low",
  usage: { input_tokens: 0, output_tokens: 0 },
  duration_api_ms: 0,
});

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
});

describe("an account-wide outage costs a habit run nothing", () => {
  it("survives the round trip from CLI envelope to thrown message and back", () => {
    // This is the real path: dispatcher parses the envelope, formats it into an
    // Error message, the verb throws it, the scheduler classifies from the text.
    const thrown = formatDiagnostic(
      summariseDispatch(
        { status: "failed", exitCode: 1, stdout: CREDIT_ENVELOPE, stderr: "" },
        "api_key_bare",
      ),
    );
    const recovered = diagnosticFromDispatchError(thrown);
    expect(recovered).not.toBeNull();
    expect(recovered?.errorCategory).toBe("credit_exhausted");
    expect(recovered?.resultSummary).toBe("Credit balance is too low");
    expect(recovered?.apiErrorStatus).toBe(400);
    expect(isGlobalOutage(recovered!)).toBe(true);
  });

  it("pausing leaves the run's retry budget, level and schedule untouched", () => {
    const before = db.prepare("SELECT * FROM habit_runs WHERE id='run-1'").get() as Record<string, unknown>;
    const d = summariseDispatch(
      { status: "failed", exitCode: 1, stdout: CREDIT_ENVELOPE, stderr: "" },
      "api_key_bare",
    );
    pauseAiDependency(db, d, 5_000);
    const after = db.prepare("SELECT * FROM habit_runs WHERE id='run-1'").get() as Record<string, unknown>;
    expect(after).toEqual(before);
    expect(after["escalation_failure_count"]).toBe(0);
    expect(after["next_escalation_at"]).toBe(1000);
  });

  it("after the pause no further run may be dispatched at all", () => {
    pauseAiDependency(
      db,
      summariseDispatch({ status: "failed", exitCode: 1, stdout: CREDIT_ENVELOPE, stderr: "" }, "api_key_bare"),
      5_000,
    );
    expect(evaluateDispatchGate(db, 5_001).allowed).toBe(false);
  });

  it("135 identical global failures would now cost zero retry attempts", () => {
    // The counterfactual of the incident, in one assertion.
    const d = summariseDispatch(
      { status: "failed", exitCode: 1, stdout: CREDIT_ENVELOPE, stderr: "" },
      "api_key_bare",
    );
    for (let i = 0; i < 135; i += 1) pauseAiDependency(db, d, 5_000 + i);
    const row = db.prepare("SELECT escalation_failure_count FROM habit_runs WHERE id='run-1'").get() as {
      escalation_failure_count: number;
    };
    expect(row.escalation_failure_count).toBe(0);
    expect(evaluateDispatchGate(db, 6_000).allowed).toBe(false);
  });

  it("a per-run fault is still charged to that run, not to the world", () => {
    const perRun = diagnosticFromDispatchError(
      formatDiagnostic(
        summariseDispatch(
          {
            status: "failed",
            exitCode: 1,
            stdout: JSON.stringify({ terminal_reason: "budget_exhausted", usage: { input_tokens: 9 } }),
            stderr: "",
          },
          "subscription",
        ),
      ),
    );
    expect(perRun?.errorCategory).toBe("budget_exhausted");
    expect(isGlobalOutage(perRun!)).toBe(false);
    expect(evaluateDispatchGate(db, 1).allowed).toBe(true);
  });
});
