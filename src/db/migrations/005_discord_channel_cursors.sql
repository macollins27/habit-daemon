-- Migration 005: discord_channel_cursors — track last-observed Discord message
-- timestamp per active channel for daemon-restart catch-up (Phase 5 of the
-- 2026-05-13 remediation plan).
--
-- Why: daemon restarts during message delivery lose the messageCreate event.
-- Persisting a per-channel cursor lets the bootstrap catch-up sweep replay
-- any messages received during the restart window.
--
-- channel_id is the Discord channel snowflake (string). last_seen_iso is the
-- discord.js Message.createdAt.toISOString() of the most recently observed
-- message in that channel — whether or not the handler matched it to a run.
-- updated_at is epoch ms when the row was last written.

CREATE TABLE IF NOT EXISTS discord_channel_cursors (
  channel_id TEXT PRIMARY KEY,
  last_seen_iso TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
