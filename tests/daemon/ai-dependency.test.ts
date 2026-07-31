// Regression tests for global AI-dependency handling.
//
// THE INCIDENT: one account-wide fault (no API credit) was processed as 135
// independent per-run faults. Each run retried 8 times and was parked forever;
// 1,083 failures, 135 dead check-ins, zero alerts. These tests hold the line
// that an account-wide fault costs the ledger nothing.

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPauseAlert,
  buildResumeAlert,
  evaluateDispatchGate,
  isGlobalOutage,
  pauseAiDependency,
  probeBackoffMs,
  readAiDependency,
  recordFailedProbe,
  resumeAiDependency,
  DEPENDENCY_PROBE_MAX_MS,
} from "../../src/daemon/ai-dependency.js";
import { summariseDispatch } from "../../src/daemon/dispatch-diagnostics.js";

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
`;

function creditExhausted() {
  return summariseDispatch(
    {
      status: "failed",
      exitCode: 1,
      stderr: "",
      stdout: JSON.stringify({
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 400,
        result: "Credit balance is too low",
        usage: { input_tokens: 0, output_tokens: 0 },
        duration_api_ms: 0,
      }),
    },
    "api_key_bare",
  );
}

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
});

describe("global AI-dependency state", () => {
  it("starts healthy and allows dispatch", () => {
    const gate = evaluateDispatchGate(db, 1_000);
    expect(gate.allowed).toBe(true);
    expect(gate.state.state).toBe("healthy");
  });

  it("recognises the account-wide categories and not the per-run ones", () => {
    expect(isGlobalOutage(creditExhausted())).toBe(true);
    const perRun = summariseDispatch(
      { status: "failed", exitCode: 1, stderr: "", stdout: JSON.stringify({ terminal_reason: "budget_exhausted" }) },
      "subscription",
    );
    expect(isGlobalOutage(perRun)).toBe(false);
  });

  it("pausing blocks ALL dispatch — the core of the incident", () => {
    pauseAiDependency(db, creditExhausted(), 10_000);
    const gate = evaluateDispatchGate(db, 10_001);
    expect(gate.allowed).toBe(false);
    expect(gate.probeDue).toBe(false); // backoff has not elapsed
    expect(gate.state.category).toBe("credit_exhausted");
    expect(gate.state.detail).toBe("Credit balance is too low");
    expect(gate.state.authMode).toBe("api_key_bare");
  });

  it("permits exactly one probe once the backoff elapses, not a run", () => {
    const t0 = 10_000;
    pauseAiDependency(db, creditExhausted(), t0);
    const before = evaluateDispatchGate(db, t0 + probeBackoffMs(0) - 1);
    expect(before.probeDue).toBe(false);
    const after = evaluateDispatchGate(db, t0 + probeBackoffMs(0));
    expect(after.allowed).toBe(false); // still no habit run may go out
    expect(after.probeDue).toBe(true);
  });

  it("a failed probe backs off further and still dispatches nothing", () => {
    const t0 = 10_000;
    pauseAiDependency(db, creditExhausted(), t0);
    recordFailedProbe(db, t0 + probeBackoffMs(0));
    const s = readAiDependency(db);
    expect(s.state).toBe("paused");
    expect(s.probeCount).toBe(1);
    expect(s.nextProbeAt).toBe(t0 + probeBackoffMs(0) + probeBackoffMs(1));
    expect(evaluateDispatchGate(db, t0 + probeBackoffMs(0) + 1).allowed).toBe(false);
  });

  it("probe backoff is bounded", () => {
    expect(probeBackoffMs(50)).toBe(DEPENDENCY_PROBE_MAX_MS);
  });

  it("a successful probe resumes dispatch and clears the cause", () => {
    pauseAiDependency(db, creditExhausted(), 10_000);
    resumeAiDependency(db, 20_000);
    const gate = evaluateDispatchGate(db, 20_001);
    expect(gate.allowed).toBe(true);
    expect(gate.state.category).toBeNull();
  });

  it("re-pausing keeps the original cause rather than overwriting it", () => {
    pauseAiDependency(db, creditExhausted(), 10_000);
    const second = summariseDispatch(
      { status: "failed", exitCode: 1, stderr: "", stdout: JSON.stringify({ api_error_status: 429, result: "rate limit" }) },
      "subscription",
    );
    pauseAiDependency(db, second, 11_000);
    expect(readAiDependency(db).category).toBe("credit_exhausted");
  });

  it("a missing table reads healthy instead of taking dispatch down", () => {
    const bare = new Database(":memory:");
    expect(readAiDependency(bare).state).toBe("healthy");
    expect(evaluateDispatchGate(bare, 1).allowed).toBe(true);
  });

  it("the pause alert is deterministic, names the cause, and needs no model", () => {
    pauseAiDependency(db, creditExhausted(), 10_000);
    const text = buildPauseAlert(readAiDependency(db));
    expect(text).toContain("PAUSED");
    expect(text).toContain("no credit");
    expect(text).toContain("Credit balance is too low");
    expect(text).toContain("without Claude");
    // Deterministic: same input, byte-identical output.
    expect(buildPauseAlert(readAiDependency(db))).toBe(text);
  });

  it("the alert never leaks a credential even if the cause contained one", () => {
    const leaky = summariseDispatch(
      {
        status: "failed",
        exitCode: 1,
        stderr: "",
        stdout: JSON.stringify({ api_error_status: 401, result: `bad key sk-ant-api03-${"Z".repeat(60)}` }),
      },
      "api_key_bare",
    );
    pauseAiDependency(db, leaky, 10_000);
    const text = buildPauseAlert(readAiDependency(db));
    expect(text).not.toContain("ZZZZZZZZZZ");
    expect(text).toContain("[REDACTED]");
  });

  it("the resume alert is deterministic too", () => {
    expect(buildResumeAlert()).toBe(buildResumeAlert());
    expect(buildResumeAlert()).toContain("RESUMED");
  });
});
