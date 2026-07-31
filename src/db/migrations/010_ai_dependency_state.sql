-- Migration 010: global AI-dependency state.
--
-- INCIDENT 2026-05-18 → 2026-07-31. The Anthropic API key's account ran out of
-- credit. Every habit-checkin dispatch therefore failed for the same
-- account-wide reason — but the failure was handled PER RUN: each run backed
-- off, retried eight times, and was then parked permanently
-- (next_escalation_at = NULL). 135 runs × 8 attempts = 1,083 failures, 135
-- permanently dead check-ins, and no alert, because the only component that
-- could have explained the failure depended on the very thing that was broken.
--
-- Migration 008's escalation_breaker stops the *dispatch storm*, but it cannot
-- prevent this: it opens only after runs have already burned attempts, its
-- half-open probe dispatches a REAL run (spending that run's budget), and it
-- makes no distinction between "this run is broken" and "the AI dependency is
-- down for everything".
--
-- This table holds that missing distinction. When a failure is classified as
-- global (credit exhausted, auth invalid, rate limited, provider unavailable,
-- CLI missing) dispatch pauses ONCE, centrally, and no run spends any part of
-- its retry budget until a single controlled probe shows the dependency is
-- healthy again.

CREATE TABLE IF NOT EXISTS ai_dependency_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  state          TEXT    NOT NULL CHECK (state IN ('healthy', 'paused')),
  -- The DispatchErrorCategory that caused the pause; NULL when healthy.
  category       TEXT,
  -- Sanitised, human-readable cause. Never contains a credential.
  detail         TEXT,
  -- Which auth path was in use when it broke, so a fix can be attributed.
  auth_mode      TEXT,
  paused_at      INTEGER,
  last_probe_at  INTEGER,
  next_probe_at  INTEGER,
  probe_count    INTEGER NOT NULL DEFAULT 0,
  -- Set when the deterministic (non-Claude) operator alert was delivered, so
  -- the pause is announced once rather than on every tick.
  alert_sent_at  INTEGER,
  updated_at     INTEGER NOT NULL
);

INSERT OR IGNORE INTO ai_dependency_state (id, state, probe_count, updated_at)
VALUES (1, 'healthy', 0, 0);
