// Phase 4 / Task 4.3: chat orchestrator.
//
// `handleUserMessage` is the single inbound verb the Discord listener calls
// when a user message arrives in an ACTIVE channel and there is no matching
// pending/partial habit_run for today. Its job:
//
//   1. Rate-limit per channel — drop messages whose channel has emitted an
//      assistant_message_sent in the last 5 seconds. Silent drop, no post.
//   2. Load the read-only chat context via loadChatContext.
//   3. Append `user_message_received` (L1) to session_events with sessionId
//      "chat".
//   4. Build the user-chat system prompt and dispatch to Claude (injected).
//   5. On success: append `assistant_message_sent` (L1) with the reply text
//      + cost, then post the reply via the injected postImpl.
//   6. On dispatch error: append `assistant_message_sent` with an apology
//      string (cost_usd=0) and post the apology to the same channel. Post
//      failures are caught + logged so the listener thread cannot crash.
//
// The orchestrator never throws to the caller — every failure mode is
// converted to a log line + a best-effort Discord post.

import type { SessionStore } from "../daemon/session-store.js";
import { loadChatContext } from "./load-chat-context.js";
import { buildUserChatSystemPrompt } from "../lib/prompt-templates/user-chat.js";

export interface HandleUserMessageOptions {
  readonly sessionStore: SessionStore;
  readonly channelId: string;
  readonly channelName: string | null;
  readonly text: string;
  readonly now: number;
  readonly dispatchImpl: (opts: {
    readonly system: string;
    readonly user: string;
    readonly maxBudgetUsd: number;
  }) => Promise<{ readonly text: string; readonly cost_usd: number }>;
  readonly postImpl: (opts: {
    readonly channelId: string;
    readonly content: string;
  }) => Promise<void>;
}

const CHAT_SESSION_ID = "chat";
const RATE_LIMIT_MS = 5_000;
const CHAT_MAX_BUDGET_USD = 0.05;
const ERROR_REPLY =
  "I hit an error answering that. Try again in a minute.";

interface RecentAssistantRow {
  readonly written_iso: string;
}

/**
 * Process a single inbound user message in a chat-eligible channel.
 *
 * Never throws — every failure path is logged + recovered with a best-effort
 * Discord post so the listener can continue handling subsequent messages.
 */
export async function handleUserMessage(
  opts: HandleUserMessageOptions,
): Promise<void> {
  const { sessionStore, channelId, channelName, text, now } = opts;
  const db = sessionStore.db;

  // 1. Per-channel rate limit. The previous assistant_message_sent's
  //    written_iso is parsed and compared against `now`. If it's within
  //    RATE_LIMIT_MS, drop silently — preserves the user's spam guard
  //    without leaving an audit gap (the dropped message is just never
  //    written to session_events, which mirrors how Discord itself treats
  //    rate-limited posts).
  const lastAssistant = db
    .prepare(
      `SELECT written_iso
         FROM session_events
        WHERE event_type = 'assistant_message_sent'
          AND json_extract(event_json, '$.channelId') = ?
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(channelId) as RecentAssistantRow | undefined;
  if (lastAssistant !== undefined) {
    const lastMs = Date.parse(lastAssistant.written_iso);
    if (Number.isFinite(lastMs) && now - lastMs < RATE_LIMIT_MS) {
      return;
    }
  }

  // 2. Load context.
  const ctx = loadChatContext({
    sessionStore,
    channelId,
    channelName,
    now,
  });

  // 3. Persist the inbound user message BEFORE dispatching. Order matters:
  //    if dispatch crashes mid-flight (e.g. subprocess kill), the user's
  //    message is still recorded so we can recover it on restart.
  sessionStore.append(
    CHAT_SESSION_ID,
    "user_message_received",
    { channelId, text },
    { trustLevel: "L1" },
  );

  // 4. Build the system prompt + dispatch.
  const system = buildUserChatSystemPrompt(ctx);

  let replyText: string;
  let costUsd: number;
  try {
    const result = await opts.dispatchImpl({
      system,
      user: text,
      maxBudgetUsd: CHAT_MAX_BUDGET_USD,
    });
    replyText = result.text;
    costUsd = result.cost_usd;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[handle-user-message] dispatch failed for channel ${channelId}: ${msg}`,
    );
    replyText = ERROR_REPLY;
    costUsd = 0;
  }

  // 5. Always persist the assistant_message_sent event — both success and
  //    error paths. Recording the apology too keeps the audit log honest:
  //    the chat session ledger always shows "user → assistant → user → ..."
  //    even when the assistant turn was an error response.
  sessionStore.append(
    CHAT_SESSION_ID,
    "assistant_message_sent",
    { channelId, text: replyText, cost_usd: costUsd },
    { trustLevel: "L1" },
  );

  // 6. Post to Discord. Wrap in its own try/catch — a post failure (rate
  //    limit, network blip, channel deleted) must not propagate to the
  //    listener thread. Matches the reconciler's swallow-and-log pattern.
  //
  //    Discord's hard limit is 2000 chars per message; replies over that
  //    get rejected. The system prompt caps at ~200 words but a Claude
  //    response can still overshoot — truncate defensively at 1900 chars
  //    with an ellipsis so the user gets a partial reply instead of silent
  //    nothing.
  const postContent = replyText.length > 1900
    ? `${replyText.slice(0, 1900)}…`
    : replyText;
  try {
    await opts.postImpl({ channelId, content: postContent });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[handle-user-message] post failed for channel ${channelId}: ${msg}`,
    );
  }
}
