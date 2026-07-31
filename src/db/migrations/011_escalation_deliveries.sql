-- Migration 011: a claim ledger for escalation deliveries.
--
-- The delivery sequence in habit-checkin is:
--     1. post the message to the channel        (external, irreversible)
--     2. record last_escalation_message_id      (local, fire-and-forget)
--     3. advance level + next_escalation_at     (local, transactional)
--
-- A process death between 1 and 3 leaves no local trace that the post
-- happened. The run keeps its level and its schedule, so the next tick posts
-- the SAME level again and the operator sees the message twice. The window is
-- small but it is real, and nothing in the schema could even detect it after
-- the fact.
--
-- This table closes that gap by writing the INTENT before the irreversible act.
-- Each (run, level) pair is one logical delivery with a stable key:
--
--     claimed   -> row inserted 'in_flight' immediately before the post
--     delivered -> row updated with the message id immediately after
--     abandoned -> released when the attempt failed BEFORE anything was posted
--
-- A row still 'in_flight' on a later attempt means a previous attempt died
-- mid-post: the outcome is UNKNOWN. The correct action there is not to retry —
-- it is to stop and be reconciled, because a blind retry is exactly how one
-- crash becomes two messages.
--
-- The PRIMARY KEY also serves as the concurrency guard: two workers racing the
-- same logical delivery cannot both claim it, because the second INSERT
-- violates the key.

CREATE TABLE IF NOT EXISTS escalation_deliveries (
  -- "<run_id>:<level>" — the logical identity of one delivery.
  delivery_key        TEXT    PRIMARY KEY,
  run_id              TEXT    NOT NULL,
  level               INTEGER NOT NULL,
  state               TEXT    NOT NULL CHECK (state IN ('in_flight', 'delivered', 'abandoned')),
  -- The channel message id, once the post is known to have succeeded.
  message_id          TEXT,
  -- Identifies the attempt that holds the claim, for post-mortem attribution.
  worker              TEXT,
  attempt_started_at  INTEGER NOT NULL,
  completed_at        INTEGER,
  -- Set when an in-doubt delivery has been adjudicated by a human or by a
  -- channel-history reconciliation, so it stops blocking future attempts.
  resolved_note       TEXT
);

CREATE INDEX IF NOT EXISTS idx_escalation_deliveries_run
  ON escalation_deliveries (run_id, level);
CREATE INDEX IF NOT EXISTS idx_escalation_deliveries_state
  ON escalation_deliveries (state);
