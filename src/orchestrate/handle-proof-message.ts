/**
 * handle-proof-message — wires the Discord listener to the verify-proof
 * routing + the downstream state transitions.
 *
 * The Discord listener (Task 22 `subscribeMessages`) calls this handler when
 * an incoming message matches an active habit_run. The handler:
 *   1. Routes the message through verify-proof (Task 33's `verifyProof`).
 *   2. Translates the sub-verb's outcome into DB writes + side effects:
 *      - 'completed': UPDATE habit_runs.status='completed', completed_at=now,
 *                     next_escalation_at=NULL. Post to #wins via wins-poster.
 *      - 'partial':   wind-down stage A already wrote the state transition
 *                     inline (it's the asymmetric verb from Task 36). Handler
 *                     is a no-op for this outcome.
 *      - 'rejected':  call recordVisionRejection (Task 19) to log the event
 *                     + maybe flip the proof_rejection_callout_due flag.
 *      - 'pending':   no-op (no claim was made; verifier waits for proof).
 *
 * The verify-proof router takes injected sub-verbs. This handler constructs
 * them with the runtime deps the bootstrap holds (concept2 creds/tokens,
 * vision dispatch impl).
 */

import type { Message } from "discord.js";
import type { SessionStore } from "../daemon/session-store.js";
import type {
  ChannelName,
  DiscordAdapter,
} from "../lib/discord-adapter.js";
import type {
  Concept2Credentials,
  Concept2Tokens,
} from "../lib/concept2-adapter.js";
import type { ActiveHabitRun } from "../lib/discord-adapter.js";

import {
  verifyProof,
  makeVerifyConcept2OrPhoto,
  makeVerifyTrainingLogPhoto,
  makeVerifyWindDownStageA,
} from "./verify-proof.js";
import { postWin, type Completion } from "./wins-poster.js";
import { recordVisionRejection } from "./vision-rejection-counter.js";
import type { VisionRejection } from "./vision-rejection-counter.js";
import { postToChannel } from "../lib/discord-adapter.js";
import { ESCALATION_FOLLOW_UP_CONTENT } from "./habit-checkin.js";

export interface HandleProofMessageOptions {
  readonly sessionStore: SessionStore;
  readonly adapter: DiscordAdapter;
  readonly sessionId: string;
  readonly run: ActiveHabitRun;
  readonly message: Message;
  readonly channelName: ChannelName;
  readonly now: number;
  readonly concept2: {
    readonly credentials: Concept2Credentials;
    readonly tokens: Concept2Tokens;
    readonly onTokensRefreshed: (newTokens: Concept2Tokens) => void;
  } | null;
  readonly visionDispatchImpl: (opts: {
    prompt: string;
    jsonSchema: string;
  }) => Promise<{ structured_output?: unknown; error?: string }>;
  /**
   * Optional chat fallback: invoked when verifyProof returns outcome "pending"
   * (i.e. the message wasn't a proof attempt — no attachment, no trigger
   * phrase). When provided, the chat handler runs INSTEAD of the
   * proof_type-tailored pending ack. Lets the user talk to Claude in any
   * active channel even when a run is open.
   */
  readonly onChatFallback?: (opts: {
    channelId: string;
    channelName: ChannelName;
    text: string;
    message: Message;
  }) => Promise<void> | void;
}

interface HabitRowForProof {
  readonly id: string;
}

interface RunCompletionData {
  readonly run_id: string;
  readonly fired_at: number;
}

interface ParsedConcept2 {
  readonly date?: string;
  readonly duration_seconds?: number;
  readonly distance_meters?: number;
}

interface StageAProofRow {
  readonly satisfied_at: number | null;
}

/**
 * Translate a verify-proof outcome into the downstream state transition for
 * the matched run. Idempotent on re-invocations within the same proof attempt.
 */
export async function handleProofMessage(
  opts: HandleProofMessageOptions,
): Promise<void> {
  const db = opts.sessionStore.db;

  // Skip if the run is already terminal — defensive against late-arriving
  // messages.
  if (opts.run.status !== "pending" && opts.run.status !== "partial") {
    return;
  }

  // Build sub-verbs with the runtime deps the handler holds.
  const verifyConcept2 = opts.concept2
    ? makeVerifyConcept2OrPhoto({
        credentials: opts.concept2.credentials,
        tokens: opts.concept2.tokens,
        onTokensRefreshed: opts.concept2.onTokensRefreshed,
        visionDispatchImpl: opts.visionDispatchImpl,
      })
    : undefined;
  const verifyTrainingLog = makeVerifyTrainingLogPhoto({
    visionDispatchImpl: opts.visionDispatchImpl,
  });
  const verifyWindDown = makeVerifyWindDownStageA({
    adapter: opts.adapter,
  });

  const result = await verifyProof({
    db,
    sessionStore: opts.sessionStore,
    sessionId: opts.sessionId,
    habitId: opts.run.habit_id,
    runId: opts.run.id,
    message: opts.message,
    now: opts.now,
    subVerbs: {
      verifyConcept2OrPhoto: verifyConcept2,
      verifyTrainingLogPhoto: verifyTrainingLog,
      verifyWindDownStageA: verifyWindDown,
    },
  });

  switch (result.outcome) {
    case "completed": {
      // Phase 6.2: read the escalation tracker BEFORE applyCompleted runs
      // its UPDATE (the UPDATE doesn't clear the column, so order is purely
      // a defensive choice — fetching first means a future change that
      // clears the column on completion can't silently regress this check).
      const lastEscalationMessageId = loadLastEscalationMessageId(
        db,
        opts.run.id,
      );

      await applyCompleted(opts, result.proofPayload);

      // Source-channel ack — fires even when buildCompletionForHabit returns
      // null (the #wins post is skipped in that case, but the user still gets
      // an in-channel "got it" so they aren't left wondering). Wrapped in an
      // independent try/catch matching `verify-proof.ts:670-682` so a flaky
      // channel post never blows up the rest of the handler.
      //
      // Phase 6.2 composite: when a prior escalation was tracked, the
      // follow-up REPLACES the standard ack — a single message reads
      // better than the two-message version of the same outcome.
      const ackContent =
        lastEscalationMessageId !== null
          ? ESCALATION_FOLLOW_UP_CONTENT
          : "Got it — see #wins. ✓";
      try {
        await postToChannel({
          adapter: opts.adapter,
          channel: opts.message.channelId,
          content: ackContent,
        });
      } catch (err: unknown) {
        console.error(
          `[handle-proof-message] source-channel completed-ack post failed for run ${opts.run.id}`,
          err,
        );
      }
      return;
    }
    case "partial": {
      // Wind-down stage A already wrote the DB transition + posted the ack
      // inline (Task 36). No further action needed here.
      return;
    }
    case "rejected": {
      applyRejected(opts, result.proofPayload, result.reason);
      try {
        const reason = result.reason ?? "rejected by verifier";
        await postToChannel({
          adapter: opts.adapter,
          channel: opts.message.channelId,
          content: `That doesn't look right — ${reason}. Try again?`,
        });
      } catch (err: unknown) {
        console.error(
          `[handle-proof-message] source-channel rejected-ack post failed for run ${opts.run.id}`,
          err,
        );
      }
      return;
    }
    case "pending":
    default: {
      // No claim was made (no attachment / phrase mismatch / etc.). The
      // user is talking to the bot, not submitting proof. If the caller
      // provided onChatFallback, route to chat instead of posting the
      // proof_type-tailored "send a photo" ack — lets users converse with
      // Claude in any active channel regardless of run state.
      if (opts.onChatFallback !== undefined) {
        try {
          const r = opts.onChatFallback({
            channelId: opts.message.channelId,
            channelName: opts.channelName,
            text: opts.message.content ?? "",
            message: opts.message,
          });
          if (r && typeof (r as Promise<void>).then === "function") {
            await (r as Promise<void>);
          }
        } catch (err: unknown) {
          console.error(
            `[handle-proof-message] chat fallback failed for run ${opts.run.id}`,
            err,
          );
        }
        return;
      }
      // No chat fallback wired — fall back to the proof_type-tailored ack.
      try {
        const habit = db
          .prepare(`SELECT proof_type FROM habits WHERE id = ?`)
          .get(opts.run.habit_id) as { proof_type: string } | undefined;
        if (habit !== undefined) {
          await postToChannel({
            adapter: opts.adapter,
            channel: opts.message.channelId,
            content: pendingAckText(habit.proof_type),
          });
        }
      } catch (err: unknown) {
        console.error(
          `[handle-proof-message] source-channel pending-ack post failed for run ${opts.run.id}`,
          err,
        );
      }
      return;
    }
  }
}

/**
 * Phase 6.2: load `habit_runs.last_escalation_message_id` for a run.
 *
 * Returns the captured Discord message id of the most recent escalation, or
 * null if no escalation has been posted for this run yet (rare but possible
 * — e.g. user posts proof before any scheduler tick fires for the day). The
 * completed-path ack uses this to pick between the follow-up text and the
 * standard "Got it" text.
 */
function loadLastEscalationMessageId(
  db: import("better-sqlite3").Database,
  runId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT last_escalation_message_id FROM habit_runs WHERE id = ?`,
    )
    .get(runId) as
    | { readonly last_escalation_message_id: string | null }
    | undefined;
  return row?.last_escalation_message_id ?? null;
}

async function applyCompleted(
  opts: HandleProofMessageOptions,
  proofPayload: unknown,
): Promise<void> {
  const db = opts.sessionStore.db;
  const sessionStore = opts.sessionStore;

  // UPDATE habit_runs + append session_event in a single tx.
  const writeTx = db.transaction((payloadJson: string): void => {
    db.prepare(
      `UPDATE habit_runs
       SET status = 'completed', completed_at = ?, next_escalation_at = NULL, proof_payload_json = ?
       WHERE id = ?`,
    ).run(opts.now, payloadJson, opts.run.id);

    sessionStore.append(
      opts.sessionId,
      "habit_completed",
      {
        habitId: opts.run.habit_id,
        runId: opts.run.id,
        completedAt: opts.now,
        proofPayload,
      },
      { trustLevel: "L1" },
    );
  });
  writeTx(JSON.stringify({ proof: proofPayload }));

  // Post to #wins. Format depends on habit domain.
  const completion = buildCompletionForHabit(opts.run.habit_id, proofPayload, opts);
  if (completion !== null) {
    await postWin({
      adapter: opts.adapter,
      status: "completed",
      completion,
    });
  }
}

function applyRejected(
  opts: HandleProofMessageOptions,
  proofPayload: unknown,
  reason: string | undefined,
): void {
  const subject = subjectForHabit(opts.run.habit_id);
  const rejection: VisionRejection = {
    subject,
    reason: reason ?? "rejected by verifier",
    parsed: proofPayload,
  };
  recordVisionRejection({
    sessionStore: opts.sessionStore,
    sessionId: opts.sessionId,
    runId: opts.run.id,
    rejection,
  });
}

/**
 * Map habit id to the vision-registry subject used for proof-rejection audit
 * trails. Only habits with a photo-proof path appear here.
 */
function subjectForHabit(habitId: string): string {
  switch (habitId) {
    case "morning-row":
      return "pm5_screen";
    case "strength-mwf":
      return "training_log";
    default:
      return habitId;
  }
}

function buildCompletionForHabit(
  habitId: string,
  proofPayload: unknown,
  opts: HandleProofMessageOptions,
): Completion | null {
  switch (habitId) {
    case "morning-row":
      return buildRowCompletion(proofPayload, opts);
    case "strength-mwf":
      return buildStrengthCompletion(opts);
    case "wind-down":
      // wind-down's #wins post is fired by evaluate-stage-b (Task 37), not
      // by the proof-message handler. Stage A satisfaction here only sets
      // status='partial'; the completed transition happens the next morning
      // when stage B resolves.
      return null;
    default:
      return null;
  }
}

function buildRowCompletion(
  proofPayload: unknown,
  opts: HandleProofMessageOptions,
): Completion {
  // Try to extract Concept2 session data for the rich format
  // "✓ Morning row · 9:42 · 12 min · 2,143m". Fall back to the message time
  // + minimal data if the payload doesn't have it (e.g., photo-fallback path).
  const payload = (proofPayload ?? {}) as {
    source?: string;
    session?: ParsedConcept2;
  };
  const session = payload.session;
  const time = formatTimeHHMM(new Date(opts.now));
  const durationMinutes =
    session?.duration_seconds !== undefined
      ? Math.round(session.duration_seconds / 60)
      : 0;
  const meters = session?.distance_meters ?? 0;
  return {
    habit: "morning-row",
    time,
    durationMinutes,
    meters,
  };
}

function buildStrengthCompletion(opts: HandleProofMessageOptions): Completion {
  return {
    habit: "strength-mwf",
    time: formatStrengthTime(new Date(opts.now)),
    liftCount: 0, // Vision payload's entries_visible isn't surfaced here;
    // future task can plumb it through. Phase A acceptable: post fires.
  };
}

function formatTimeHHMM(d: Date): string {
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function formatStrengthTime(d: Date): string {
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const h12 = d.getHours() % 12 || 12;
  const ampm = d.getHours() >= 12 ? "pm" : "am";
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${weekday ?? "?"} ${h12}:${m}${ampm}`;
}

/**
 * Per-proof_type "I see your message, still waiting for proof" text. Used by
 * the pending-outcome source-channel ack so the user knows the bot saw them
 * and what specifically it's waiting on. Strings track `seed-habits.ts`.
 */
function pendingAckText(proofType: string): string {
  switch (proofType) {
    case "concept2_api+photo_fallback":
      return "I see your message. Don't have proof yet — send a photo of the PM5 or finish the row and it'll sync automatically.";
    case "typed_msg+garmin_sleep":
      return "I see your message. Still waiting for either the trigger phrase ('shutting down', etc.) or the Garmin sleep data.";
    case "training_log_photo":
      return "I see your message. Send a photo of the training log to mark this done.";
    default:
      return "I see your message. Still need proof for this habit.";
  }
}
