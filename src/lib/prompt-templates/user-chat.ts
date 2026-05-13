// Phase 4: user-chat system-prompt builder.
//
// `handleUserMessage` (the chat orchestrator) calls this when the user sends a
// free-text message into one of the active habit channels with no matching
// run. The output is a system prompt for Claude that constrains the assistant
// to a read-only, factual Q&A surface over the habit ledger.
//
// Design contract:
//   - The model NEVER fabricates: every fact must come from the embedded
//     `ChatContext` JSON. Lack of evidence is reported, not papered over.
//   - Chat is read-only. Asks like "mark today complete" are politely
//     declined; the human-edit surface is the web UI.
//   - Channel context biases the reply when present (e.g. a message in
//     #morning-row gets a row-leaning answer) but does NOT restrict the
//     model to one habit — the user may ask cross-habit questions anywhere.
//   - Reply shape: plain text, ~200 words max, sparse "✓"/"✗" markers, no
//     emoji decoration. Discord-friendly.
//
// The full `ChatContext` is embedded as a single fenced JSON block. This
// keeps the prompt machine-readable (the model sees exactly the same fields
// the loader produced) and makes the surface easy to evolve: adding a new
// field in `load-chat-context.ts` automatically threads it to the model
// without any prompt-template surgery.

/**
 * The denormalized snapshot the chat assistant sees.
 *
 * Mirrors the shape produced by `loadChatContext` in
 * `src/orchestrate/load-chat-context.ts`. Defining the interface here (and
 * re-exporting from the loader) keeps the prompt builder and its single
 * caller in lock-step without a circular import.
 */
export interface ChatContext {
  readonly nowIso: string;
  readonly channelName: string | null;
  readonly habits: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly domain: string;
    readonly proof_type: string;
    readonly archived_at: string | null;
  }>;
  readonly todayRuns: ReadonlyArray<{
    readonly habit_id: string;
    readonly fire_date: string;
    readonly status: string;
    readonly current_level: number;
    readonly completed_at: number | null;
  }>;
  readonly recentRuns30d: ReadonlyArray<{
    readonly habit_id: string;
    readonly fire_date: string;
    readonly status: string;
  }>;
  readonly recentEvents: ReadonlyArray<{
    readonly seq: number;
    readonly event_type: string | null;
    readonly written_iso: string;
    readonly event_json: string;
  }>;
  readonly recentMissReasons: ReadonlyArray<{
    readonly habit_id: string;
    readonly miss_date: string;
    readonly classification: string | null;
    readonly user_response_text: string | null;
  }>;
  readonly sensorRecency: {
    readonly concept2_last_iso: string | null;
    readonly garmin_last_iso: string | null;
  };
  readonly recentChat: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly channelId: string;
    readonly text: string;
    readonly iso: string;
  }>;
}

/**
 * Build the system prompt for the read-only Q&A assistant.
 *
 * The prompt is intentionally directive: the model must answer only from the
 * embedded context, must decline action requests, and must keep replies short.
 * The embedded JSON is fenced so the model can re-quote individual fields back
 * without ambiguity.
 */
export function buildUserChatSystemPrompt(ctx: ChatContext): string {
  const channelLine =
    ctx.channelName !== null
      ? `The user is asking from the #${ctx.channelName} channel. Bias your answer toward the ${ctx.channelName} habit when the question is ambiguous, but do NOT refuse questions about other habits — answer them too.`
      : `The user is asking from a channel not tied to a specific active habit. Treat the question as general.`;

  return [
    "You are the habit-daemon's read-only Q&A assistant in Discord.",
    "",
    "Your job: answer Max's questions about his habits, current run status,",
    "recent history, miss reasons, and sensor recency, using ONLY the data",
    "in the JSON context block below. Never invent facts, dates, or numbers.",
    "If the answer is not present in the context, say so plainly.",
    "",
    "Channel context:",
    channelLine,
    "",
    "What you CANNOT do (chat is read-only):",
    "- You CANNOT mark a run complete, missed, skipped, or partial.",
    "- You CANNOT change schedules, cadences, proof rules, or any habit field.",
    "- You CANNOT archive, unarchive, or create habits.",
    "- You CANNOT trigger sensor syncs, escalations, or any verb.",
    "If the user asks you to take an action, politely decline in one sentence",
    "and tell them edits happen in the web UI. Do not pretend to perform the",
    "action. Do not promise to do it later.",
    "",
    "Reply shape:",
    "- Plain text. No markdown headers, no bullet lists unless the question",
    "  literally requires a list of items.",
    "- ~200 words MAXIMUM. Most answers are 1-3 sentences.",
    "- Use ✓ and ✗ sparingly when contrasting completed vs missed runs.",
    "- No emoji decoration, no motivational filler, no 'great question!'.",
    "- Speak directly to Max. Second person.",
    "",
    "Context (the only source of truth — quote it, don't infer beyond it):",
    "```json",
    JSON.stringify(ctx, null, 2),
    "```",
  ].join("\n");
}
