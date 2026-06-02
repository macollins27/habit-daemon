// Phase 4 / Task 4.2: load the read-only Q&A context for the chat assistant.
//
// `loadChatContext` is a pure, synchronous denormalizer over `sessionStore.db`.
// Given a channelId + channelName + clock, it returns a `ChatContext` snapshot
// that `buildUserChatSystemPrompt` can embed directly into a Claude prompt.
//
// All seven source queries are sync (better-sqlite3) and bounded:
//   1. habits — full table (small).
//   2. todayRuns — runs whose fire_date = localDateString(now).
//   3. recentRuns30d — runs within 30 days of now, newest first.
//   4. recentEvents — last 100 session_events by insertion order.
//   5. recentMissReasons — miss_reasons within 30 days of now.
//   6. sensorRecency — MAX(fetched_at) per source, converted to ISO.
//   7. recentChat — last 8 chat events (user/assistant) for this channel,
//      within the last hour, ordered oldest-first so the model can read
//      the conversation in natural order.
//
// The loader is read-only: it never writes to session_events or any other
// table. The chat orchestrator (handle-user-message.ts) is responsible for
// appending the user_message_received / assistant_message_sent events.

import type { SessionStore } from "../daemon/session-store.js";
import {
  type ChatContext,
} from "../lib/prompt-templates/user-chat.js";
import { localDateString } from "../lib/local-date.js";

// Re-export so callers can import the shape from the orchestrator module
// (handle-user-message.ts) without reaching across to prompt-templates.
export type { ChatContext } from "../lib/prompt-templates/user-chat.js";

export interface LoadChatContextOptions {
  readonly sessionStore: SessionStore;
  readonly channelId: string;
  readonly channelName: string | null;
  readonly now: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

interface HabitRow {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly proof_type: string;
  readonly archived_at: string | null;
}

interface TodayRunRow {
  readonly habit_id: string;
  readonly fire_date: string;
  readonly status: string;
  readonly current_level: number;
  readonly completed_at: number | null;
}

interface RecentRunRow {
  readonly habit_id: string;
  readonly fire_date: string;
  readonly status: string;
}

interface RecentEventRow {
  readonly seq: number;
  readonly event_type: string | null;
  readonly written_iso: string;
  readonly event_json: string;
}

interface MissReasonRow {
  readonly habit_id: string;
  readonly miss_date: string;
  readonly classification: string | null;
  readonly user_response_text: string | null;
}

interface SensorMaxRow {
  readonly last_fetched_at: number | null;
}

interface RecentChatEventRow {
  readonly written_iso: string;
  readonly event_type: string;
  readonly event_json: string;
}

interface ChatEventPayload {
  readonly channelId?: unknown;
  readonly text?: unknown;
}

function isoFromEpochOrNull(epoch: number | null): string | null {
  if (epoch === null || !Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString();
}

/**
 * Load the full chat context for a single (channelId, now) point.
 *
 * Pure over `sessionStore.db` — never mutates state.
 */
export function loadChatContext(opts: LoadChatContextOptions): ChatContext {
  const { sessionStore, channelId, channelName, now } = opts;
  const db = sessionStore.db;

  const today = localDateString(now);
  const thirtyDaysAgo = localDateString(now - THIRTY_DAYS_MS);
  const hourAgoIso = new Date(now - ONE_HOUR_MS).toISOString();

  const habits = db
    .prepare(
      `SELECT id, name, domain, proof_type, archived_at FROM habits`,
    )
    .all() as readonly HabitRow[];

  const todayRuns = db
    .prepare(
      `SELECT habit_id, fire_date, status, current_level, completed_at
         FROM habit_runs
        WHERE fire_date = ?`,
    )
    .all(today) as readonly TodayRunRow[];

  const recentRuns30d = db
    .prepare(
      `SELECT habit_id, fire_date, status
         FROM habit_runs
        WHERE fire_date >= ?
        ORDER BY fire_date DESC`,
    )
    .all(thirtyDaysAgo) as readonly RecentRunRow[];

  const recentEvents = db
    .prepare(
      `SELECT seq, event_type, written_iso, event_json
         FROM session_events
        ORDER BY id DESC
        LIMIT 100`,
    )
    .all() as readonly RecentEventRow[];

  const recentMissReasons = db
    .prepare(
      `SELECT habit_id, miss_date, classification, user_response_text
         FROM miss_reasons
        WHERE miss_date >= ?
        ORDER BY miss_date DESC`,
    )
    .all(thirtyDaysAgo) as readonly MissReasonRow[];

  const concept2Max = db
    .prepare(
      `SELECT MAX(fetched_at) AS last_fetched_at
         FROM sensor_signals
        WHERE source = 'concept2'`,
    )
    .get() as SensorMaxRow | undefined;
  const garminMax = db
    .prepare(
      `SELECT MAX(fetched_at) AS last_fetched_at
         FROM sensor_signals
        WHERE source = 'garmin'`,
    )
    .get() as SensorMaxRow | undefined;

  // Last 8 chat events (any role) for this channel inside the 1-hour window.
  // We select id DESC (autoincrement insertion order) + LIMIT 8 to bound the
  // scan, then reverse so the prompt sees oldest-first conversation order.
  // Ordering by id rather than written_iso avoids ties when two events land
  // in the same millisecond (common in tests and possible in production).
  const recentChatRows = db
    .prepare(
      `SELECT written_iso, event_type, event_json
         FROM session_events
        WHERE event_type IN ('user_message_received', 'assistant_message_sent')
          AND written_iso >= ?
          AND json_extract(event_json, '$.channelId') = ?
        ORDER BY id DESC
        LIMIT 8`,
    )
    .all(hourAgoIso, channelId) as readonly RecentChatEventRow[];

  const recentChat: ChatContext["recentChat"] = [...recentChatRows]
    .reverse()
    .map((row) => {
      let payload: ChatEventPayload = {};
      try {
        payload = JSON.parse(row.event_json) as ChatEventPayload;
      } catch {
        payload = {};
      }
      const text = typeof payload.text === "string" ? payload.text : "";
      const role: "user" | "assistant" =
        row.event_type === "user_message_received" ? "user" : "assistant";
      return {
        role,
        channelId,
        text,
        iso: row.written_iso,
      };
    });

  return {
    nowIso: new Date(now).toISOString(),
    channelName,
    habits: habits.map((h) => ({
      id: h.id,
      name: h.name,
      domain: h.domain,
      proof_type: h.proof_type,
      archived_at: h.archived_at,
    })),
    todayRuns: todayRuns.map((r) => ({
      habit_id: r.habit_id,
      fire_date: r.fire_date,
      status: r.status,
      current_level: r.current_level,
      completed_at: r.completed_at,
    })),
    recentRuns30d: recentRuns30d.map((r) => ({
      habit_id: r.habit_id,
      fire_date: r.fire_date,
      status: r.status,
    })),
    recentEvents: recentEvents.map((e) => ({
      seq: e.seq,
      event_type: e.event_type,
      written_iso: e.written_iso,
      event_json: e.event_json,
    })),
    recentMissReasons: recentMissReasons.map((m) => ({
      habit_id: m.habit_id,
      miss_date: m.miss_date,
      classification: m.classification,
      user_response_text: m.user_response_text,
    })),
    sensorRecency: {
      concept2_last_iso: isoFromEpochOrNull(
        concept2Max?.last_fetched_at ?? null,
      ),
      garmin_last_iso: isoFromEpochOrNull(garminMax?.last_fetched_at ?? null),
    },
    recentChat,
  };
}
