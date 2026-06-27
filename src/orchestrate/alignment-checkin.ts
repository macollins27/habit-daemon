/**
 * runAlignmentCheckin — the escalation engine for the daily-alignment habit.
 *
 * This is a DEDICATED, fail-soft alternative to `runHabitCheckin` for one
 * habit only. It exists because the daily-alignment habit's needs are
 * fundamentally different from the sensor habits:
 *
 *   - FIXED escalation copy (the 4 questions), not Claude-generated text.
 *   - An HOURLY cadence bounded by a per-CALENDAR-DAY cap, not the 5-level
 *     terminal model (whose templates hard-throw above L5).
 *   - A second transport (iMessage) with quiet-hours + min-interval guards.
 *
 * Forcing those through the 1100-line `runHabitCheckin` would mean fighting
 * its level/template/why-well/Claude-generation machinery, so this is a clean
 * separate path. The dispatch switch routes the alignment habit here and
 * leaves the sensor habits' engine completely untouched.
 *
 * FAIL-SOFT CONTRACT (critical): the scheduler treats a thrown dispatch as a
 * failure and, after enough failures, opens a SHARED circuit breaker that
 * stalls escalation for ALL habits. So this function NEVER throws on a
 * transport error — a failed text is recorded and the loop re-arms for the
 * next hour. Only genuinely unexpected programmer errors propagate.
 *
 * The whole feature is gated: when SMS is disabled the alignment habit's
 * escalations are recorded (so the cap still bounds them) and posted to
 * Discord only — no texts go out.
 */

import type { SessionStore } from "../daemon/session-store.js";
import {
  isWithinQuietHours,
  intervalElapsed,
  nextLocalTimeAfter,
  type SmsConfig,
} from "../lib/sms-config.js";

/** Hourly cadence between escalations (the user's "text me once an hour"). */
export const ALIGNMENT_CADENCE_MINUTES = 60;

/**
 * Fixed escalation copy, selected by how many escalations have already gone
 * out today: 0 → L1 (full prompt), 1 → L2, 2+ → L3. Verbatim intent from the
 * operator's brief; L1 carries the four questions so the first text is
 * self-contained.
 */
export const ALIGNMENT_COPY: Readonly<Record<1 | 2 | 3, string>> = {
  1: [
    "Daily alignment checkpoint. Answer before AI/work:",
    "1. What am I avoiding?",
    "2. What is the smallest real start today?",
    "3. What are 3 wins today?",
    "4. What habit is interfering today?",
  ].join("\n"),
  2: "You're trying to bypass the checkpoint. Four answers — concrete, not abstract. Do it now.",
  3: "This is the rut loop. You don't get to negotiate with the part of you that skips the checkpoint. Submit the four answers.",
};

function copyForCount(priorCount: number): { level: 1 | 2 | 3; body: string } {
  const level: 1 | 2 | 3 = priorCount <= 0 ? 1 : priorCount === 1 ? 2 : 3;
  return { level, body: ALIGNMENT_COPY[level] };
}

export interface SendTextOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

export interface RunAlignmentCheckinOptions {
  readonly sessionStore: SessionStore;
  readonly runId: string;
  /** epoch ms */
  readonly now: number;
  readonly smsConfig: SmsConfig;
  /**
   * Send a text. Injected so tests never spawn osascript. Production binds
   * this to the iMessage adapter + the configured destination number. When
   * SMS is disabled this is never called.
   */
  readonly sendTextImpl?: (body: string) => Promise<SendTextOutcome>;
  /**
   * Post the same nag to the habit's Discord channel (so the channel has
   * context and the proof reply has somewhere to land). Best-effort; a
   * failure here never blocks the text or the re-arm.
   */
  readonly postImpl?: (opts: {
    channel: string;
    content: string;
  }) => Promise<{ messageId: string }>;
}

export type AlignmentAction =
  | "sent" // escalation delivered (and counted)
  | "capped" // daily cap reached → run marked missed, escalation stopped
  | "quiet" // inside quiet hours → re-armed to the end of quiet hours
  | "throttled" // inside the min-interval → re-armed to the floor
  | "noop"; // run no longer pending (completed/missed/skipped) → nothing to do

export interface RunAlignmentCheckinResult {
  readonly action: AlignmentAction;
  readonly smsSent: boolean;
  /** Escalations delivered today AFTER this invocation. */
  readonly countToday: number;
  /** The next_escalation_at written (null = escalation stopped). */
  readonly nextEscalationAt: number | null;
}

interface AlignmentRunRow {
  readonly id: string;
  readonly habit_id: string;
  readonly fire_date: string;
  readonly status: string;
  readonly channel_id: string;
}

interface CountRow {
  readonly n: number;
}
interface LastRow {
  readonly last_sent: number | null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

/**
 * Run one alignment escalation tick. See FAIL-SOFT CONTRACT above.
 */
export async function runAlignmentCheckin(
  opts: RunAlignmentCheckinOptions,
): Promise<RunAlignmentCheckinResult> {
  const db = opts.sessionStore.db;
  const { runId, now, smsConfig } = opts;

  const run = db
    .prepare(
      `SELECT r.id, r.habit_id, r.fire_date, r.status, h.channel_id
         FROM habit_runs r JOIN habits h ON h.id = r.habit_id
        WHERE r.id = ?`,
    )
    .get(runId) as AlignmentRunRow | undefined;

  // Missing or non-pending run → nothing to escalate. Do NOT re-arm or throw.
  if (run === undefined || run.status !== "pending") {
    return {
      action: "noop",
      smsSent: false,
      countToday: 0,
      nextEscalationAt: null,
    };
  }

  const countToday =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM alignment_sms_sends WHERE habit_id = ? AND fire_date = ?`,
        )
        .get(run.habit_id, run.fire_date) as CountRow
    ).n ?? 0;

  // 1. Daily cap → stop for the day. Mark the run missed so the scheduler's
  //    pending-only escalation query never picks it up again today.
  if (countToday >= smsConfig.maxPerDay) {
    db.prepare(
      `UPDATE habit_runs SET status = 'missed', next_escalation_at = NULL WHERE id = ?`,
    ).run(runId);
    return {
      action: "capped",
      smsSent: false,
      countToday,
      nextEscalationAt: null,
    };
  }

  // 2. Quiet hours → sleep until the window ends (do not send, do not count).
  if (
    isWithinQuietHours(
      new Date(now),
      smsConfig.quietHoursStart,
      smsConfig.quietHoursEnd,
    )
  ) {
    const resumeAt =
      smsConfig.quietHoursEnd !== null
        ? nextLocalTimeAfter(now, smsConfig.quietHoursEnd)
        : null;
    const next = resumeAt ?? now + ALIGNMENT_CADENCE_MINUTES * 60_000;
    db.prepare(
      `UPDATE habit_runs SET next_escalation_at = ? WHERE id = ?`,
    ).run(next, runId);
    return { action: "quiet", smsSent: false, countToday, nextEscalationAt: next };
  }

  // 3. Min-interval floor → re-arm to the earliest allowed time.
  const lastSent =
    (
      db
        .prepare(
          `SELECT MAX(sent_at) AS last_sent FROM alignment_sms_sends WHERE habit_id = ? AND fire_date = ?`,
        )
        .get(run.habit_id, run.fire_date) as LastRow
    ).last_sent ?? null;
  if (!intervalElapsed(lastSent, now, smsConfig.minIntervalMinutes)) {
    const next = (lastSent ?? now) + smsConfig.minIntervalMinutes * 60_000;
    db.prepare(
      `UPDATE habit_runs SET next_escalation_at = ? WHERE id = ?`,
    ).run(next, runId);
    return {
      action: "throttled",
      smsSent: false,
      countToday,
      nextEscalationAt: next,
    };
  }

  // 4. Deliver the escalation. Discord post + (if enabled) iMessage. Both are
  //    best-effort; neither failure throws.
  const { level, body } = copyForCount(countToday);

  if (opts.postImpl !== undefined) {
    try {
      await opts.postImpl({ channel: run.channel_id, content: body });
    } catch (err: unknown) {
      process.stderr.write(
        `[alignment-checkin] discord post failed for run ${runId}: ${getErrorMessage(err)}\n`,
      );
    }
  }

  let smsOk = false;
  if (smsConfig.enabled && smsConfig.toNumber !== null && opts.sendTextImpl) {
    try {
      const res = await opts.sendTextImpl(body);
      smsOk = res.ok;
      if (!res.ok) {
        process.stderr.write(
          `[alignment-checkin] text send failed for run ${runId}: ${res.error ?? "unknown"}\n`,
        );
      }
    } catch (err: unknown) {
      // Defensive: sendTextImpl is contracted not to throw, but never let it
      // poison the shared circuit breaker if it does.
      process.stderr.write(
        `[alignment-checkin] text send threw for run ${runId}: ${getErrorMessage(err)}\n`,
      );
    }
  }

  // 5. Record the attempt (the cap/interval source of truth) + re-arm hourly,
  //    atomically.
  const next = now + ALIGNMENT_CADENCE_MINUTES * 60_000;
  const writeTx = db.transaction(() => {
    db.prepare(
      `INSERT INTO alignment_sms_sends (habit_id, run_id, fire_date, sent_at, level, sms_ok)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(run.habit_id, runId, run.fire_date, now, level, smsOk ? 1 : 0);
    db.prepare(
      `UPDATE habit_runs SET next_escalation_at = ? WHERE id = ?`,
    ).run(next, runId);
  });
  writeTx();

  return {
    action: "sent",
    smsSent: smsOk,
    countToday: countToday + 1,
    nextEscalationAt: next,
  };
}
