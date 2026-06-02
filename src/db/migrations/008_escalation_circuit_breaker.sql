-- Persistent escalation circuit breaker (incident 2026-06-02 follow-up).
--
-- Per-run exponential backoff alone never gives up: a perpetually-failing run
-- (out of credit, or a deterministic config bug) kept retrying forever, just
-- slowly — a steady trickle of dead claude sessions. This breaker lets the
-- scheduler STOP dispatching entirely when habit-checkin is failing
-- systemically, and probe sparsely (exponential cooldown) to auto-detect
-- recovery. Singleton row (id = 1).
CREATE TABLE IF NOT EXISTS escalation_breaker (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  state                TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at            INTEGER,
  probe_cooldown_ms    INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT
);

INSERT OR IGNORE INTO escalation_breaker (id, state, consecutive_failures, probe_cooldown_ms)
VALUES (1, 'closed', 0, 0);
