// Global AI-dependency state — the difference between "this run is broken" and
// "the thing every run needs is down".
//
// The 2026-05-18 → 2026-07-31 outage was a single account-wide fault (no API
// credit) processed 135 times as 135 unrelated per-run faults. Each run backed
// off, retried its full budget of eight, and was parked forever. The correct
// response to an account-wide fault is to stop dispatching ONCE, spend nothing
// further, tell the operator in plain language, and probe for recovery with a
// single controlled request rather than with the operator's real check-ins.
//
// Deliberate constraint: nothing in this module calls Claude. The component
// that reports "Claude is unavailable" must not itself require Claude, or the
// alert dies with the dependency — which is precisely what happened.

import type Database from "better-sqlite3";
import { isGlobalDependencyFailure, type DispatchDiagnostic } from "./dispatch-diagnostics.js";

/** First pause probe delay; doubles per failed probe up to the max. */
export const DEPENDENCY_PROBE_BASE_MS = 15 * 60 * 1000; // 15 minutes
export const DEPENDENCY_PROBE_MAX_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface AiDependencyState {
  readonly state: "healthy" | "paused";
  readonly category: string | null;
  readonly detail: string | null;
  readonly authMode: string | null;
  readonly pausedAt: number | null;
  readonly lastProbeAt: number | null;
  readonly nextProbeAt: number | null;
  readonly probeCount: number;
  readonly alertSentAt: number | null;
}

const HEALTHY: AiDependencyState = {
  state: "healthy",
  category: null,
  detail: null,
  authMode: null,
  pausedAt: null,
  lastProbeAt: null,
  nextProbeAt: null,
  probeCount: 0,
  alertSentAt: null,
};

interface Row {
  readonly state: string;
  readonly category: string | null;
  readonly detail: string | null;
  readonly auth_mode: string | null;
  readonly paused_at: number | null;
  readonly last_probe_at: number | null;
  readonly next_probe_at: number | null;
  readonly probe_count: number;
  readonly alert_sent_at: number | null;
}

/**
 * Read the state. A missing table (legacy or smoke-test schema) reads as
 * healthy: an observability feature must never take dispatch down with it.
 */
export function readAiDependency(db: Database.Database): AiDependencyState {
  try {
    const row = db
      .prepare(
        `SELECT state, category, detail, auth_mode, paused_at, last_probe_at,
                next_probe_at, probe_count, alert_sent_at
           FROM ai_dependency_state WHERE id = 1`,
      )
      .get() as Row | undefined;
    if (row === undefined) return HEALTHY;
    return {
      state: row.state === "paused" ? "paused" : "healthy",
      category: row.category,
      detail: row.detail,
      authMode: row.auth_mode,
      pausedAt: row.paused_at,
      lastProbeAt: row.last_probe_at,
      nextProbeAt: row.next_probe_at,
      probeCount: row.probe_count,
      alertSentAt: row.alert_sent_at,
    };
  } catch {
    return HEALTHY;
  }
}

export function probeBackoffMs(probeCount: number): number {
  const grown = DEPENDENCY_PROBE_BASE_MS * Math.pow(2, Math.max(0, probeCount));
  return Math.min(grown, DEPENDENCY_PROBE_MAX_MS);
}

/**
 * Should this diagnostic take the whole dependency down rather than one run?
 */
export function isGlobalOutage(d: DispatchDiagnostic): boolean {
  return isGlobalDependencyFailure(d.errorCategory);
}

/** Pause dispatch globally. Idempotent: re-pausing keeps the original cause. */
export function pauseAiDependency(
  db: Database.Database,
  d: DispatchDiagnostic,
  nowMs: number,
): AiDependencyState {
  const current = readAiDependency(db);
  if (current.state === "paused") return current;
  try {
    db.prepare(
      `UPDATE ai_dependency_state
          SET state = 'paused', category = ?, detail = ?, auth_mode = ?,
              paused_at = ?, next_probe_at = ?, probe_count = 0,
              alert_sent_at = NULL, updated_at = ?
        WHERE id = 1`,
    ).run(
      d.errorCategory,
      d.resultSummary ?? d.errorCategory,
      d.authMode,
      nowMs,
      nowMs + probeBackoffMs(0),
      nowMs,
    );
  } catch {
    return current;
  }
  return readAiDependency(db);
}

/** The dependency answered a probe successfully — resume normal dispatch. */
export function resumeAiDependency(db: Database.Database, nowMs: number): void {
  try {
    db.prepare(
      `UPDATE ai_dependency_state
          SET state = 'healthy', category = NULL, detail = NULL, auth_mode = NULL,
              paused_at = NULL, next_probe_at = NULL, last_probe_at = ?,
              probe_count = 0, alert_sent_at = NULL, updated_at = ?
        WHERE id = 1`,
    ).run(nowMs, nowMs);
  } catch {
    /* table absent — nothing to persist */
  }
}

/** A probe failed: back off further without touching any habit run. */
export function recordFailedProbe(db: Database.Database, nowMs: number): void {
  const s = readAiDependency(db);
  const nextCount = s.probeCount + 1;
  try {
    db.prepare(
      `UPDATE ai_dependency_state
          SET probe_count = ?, last_probe_at = ?, next_probe_at = ?, updated_at = ?
        WHERE id = 1`,
    ).run(nextCount, nowMs, nowMs + probeBackoffMs(nextCount), nowMs);
  } catch {
    /* table absent */
  }
}

export function markAlertSent(db: Database.Database, nowMs: number): void {
  try {
    db.prepare(
      `UPDATE ai_dependency_state SET alert_sent_at = ?, updated_at = ? WHERE id = 1`,
    ).run(nowMs, nowMs);
  } catch {
    /* table absent */
  }
}

export interface DispatchGate {
  /** May habit runs be dispatched on this tick? */
  readonly allowed: boolean;
  /** Is a single controlled recovery probe due instead? */
  readonly probeDue: boolean;
  readonly state: AiDependencyState;
}

/**
 * The gate every tick consults. When paused, NO run is dispatched and no run
 * spends any retry budget — the only thing that may run is one probe, and only
 * once its backoff has elapsed.
 */
export function evaluateDispatchGate(
  db: Database.Database,
  nowMs: number,
): DispatchGate {
  const state = readAiDependency(db);
  if (state.state === "healthy") {
    return { allowed: true, probeDue: false, state };
  }
  const probeDue = state.nextProbeAt !== null && nowMs >= state.nextProbeAt;
  return { allowed: false, probeDue, state };
}

/**
 * The operator-facing pause alert. Deterministic string assembly — no model
 * call, no network dependency beyond the channel post itself.
 */
export function buildPauseAlert(state: AiDependencyState): string {
  const cause = state.detail ?? state.category ?? "unknown";
  const reason =
    state.category === "credit_exhausted"
      ? "the Anthropic API account backing habit-daemon has no credit"
      : state.category === "auth_invalid"
        ? "habit-daemon's Claude credentials were rejected"
        : state.category === "rate_limited"
          ? "habit-daemon is being rate limited by the Claude API"
          : state.category === "provider_unavailable"
            ? "the Claude API is unavailable"
            : state.category === "cli_unavailable"
              ? "the claude command could not be run on this machine"
              : "the Claude dependency is unavailable";

  return [
    "**Habit check-ins are PAUSED.**",
    "",
    `Reason: ${reason}.`,
    `Reported cause: ${cause}`,
    `Auth mode in use: ${state.authMode ?? "unknown"}`,
    "",
    "No check-in has been lost to this: every pending run keeps its current",
    "state and none is spending retry attempts while the pause is in effect.",
    "Delivery resumes automatically once a recovery probe succeeds.",
    "",
    "_This message was generated without Claude, by design._",
  ].join("\n");
}

export function buildResumeAlert(): string {
  return [
    "**Habit check-ins have RESUMED.**",
    "",
    "A recovery probe succeeded, so the Claude dependency is healthy again and",
    "scheduled check-ins are dispatching normally.",
    "",
    "_This message was generated without Claude, by design._",
  ].join("\n");
}
