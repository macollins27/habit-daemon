/**
 * VISION_REGISTRY — subject → { prompt, schema, threshold } table.
 *
 * Used by the vision-verify wrapper (Task 18) to: (1) issue Claude vision
 * prompts for proof-photo classification, (2) parse the structured JSON
 * response, and (3) apply a deterministic pass/fail threshold so the rest
 * of the daemon does not embed model judgment in business logic.
 *
 * Source of truth: docs/plans/2026-05-12-habit-daemon-design.md § 4
 * ("Vision verification"). The two registered subjects mirror the design
 * verbatim: `training_log` (proof photo for the row habit's training-log
 * stage) and `pm5_screen` (Concept2 PM5 monitor screen for completed
 * rowing sessions, used when a Logbook API pull is missing).
 *
 * Thresholds are pure functions: same input → same output, no I/O. The
 * `training_log` confidence floor of 0.7 is a Phase A defensive heuristic
 * (the design only specifies "≥3 distinct lift entries"); future tasks
 * can tune it once we have real photo data. The pm5_screen threshold is
 * verbatim from § 4: `duration_minutes >= 10 AND completed === true`.
 *
 * Adding new proof types requires a new registry entry here, not ad-hoc
 * prompts in habit configs.
 */

import { z } from "zod";

/**
 * Expected JSON shape from the Claude vision call for the training_log
 * subject. Mirrors the schema specified in design § 4.
 */
export const TrainingLogResponseSchema = z.object({
  is_training_log: z.boolean(),
  entries_visible: z.number(),
  confidence: z.number().min(0).max(1),
  rejection_reason: z.string().optional(),
});
export type TrainingLogResponse = z.infer<typeof TrainingLogResponseSchema>;

/**
 * Expected JSON shape from the Claude vision call for the pm5_screen
 * subject. Mirrors the schema specified in design § 4.
 */
export const Pm5ScreenResponseSchema = z.object({
  is_pm5: z.boolean(),
  duration_minutes: z.number(),
  meters: z.number(),
  completed: z.boolean(),
  confidence: z.number().min(0).max(1),
  rejection_reason: z.string().optional(),
});
export type Pm5ScreenResponse = z.infer<typeof Pm5ScreenResponseSchema>;

/**
 * Threshold evaluation result. `passed=true` means the parsed vision
 * response satisfies the subject's acceptance criteria; otherwise
 * `reason` carries a short human-readable explanation suitable for
 * logging and Discord rejection callouts.
 */
export interface ThresholdResult {
  readonly passed: boolean;
  readonly reason?: string;
}

/**
 * Per-subject vision registry entry. The generic parameter pins the
 * parsed-response type so consumers (Task 18 vision-verify) get a typed
 * payload back from `schema.parse(...)` before invoking `threshold`.
 */
export interface VisionRegistryEntry<TResponse> {
  readonly prompt: string;
  readonly schema: z.ZodType<TResponse>;
  readonly threshold: (parsed: TResponse) => ThresholdResult;
}

const TRAINING_LOG_PROMPT = `Verify this is a photo of a workout/training log. Confirm: ≥3 distinct lift entries are visible, each entry shows lift name + weight + reps. Return JSON: { is_training_log: bool, entries_visible: number, confidence: 0-1, rejection_reason?: string }`;

const PM5_SCREEN_PROMPT = `Verify this is a photo of a Concept2 PM5 monitor showing a completed rowing session. Confirm: duration ≥ 10:00, meters visible, screen shows completed (not in-progress) session. Return JSON: { is_pm5: bool, duration_minutes: number, meters: number, completed: bool, confidence: 0-1, rejection_reason?: string }`;

const TRAINING_LOG_MIN_ENTRIES = 3;
const TRAINING_LOG_MIN_CONFIDENCE = 0.7;
const PM5_MIN_DURATION_MINUTES = 10;

export const VISION_REGISTRY: {
  readonly training_log: VisionRegistryEntry<TrainingLogResponse>;
  readonly pm5_screen: VisionRegistryEntry<Pm5ScreenResponse>;
} = {
  training_log: {
    prompt: TRAINING_LOG_PROMPT,
    schema: TrainingLogResponseSchema,
    threshold: (parsed: TrainingLogResponse): ThresholdResult => {
      if (!parsed.is_training_log) {
        return { passed: false, reason: "not a training log" };
      }
      if (parsed.entries_visible < TRAINING_LOG_MIN_ENTRIES) {
        return {
          passed: false,
          reason: `only ${parsed.entries_visible} entries visible (need >= ${TRAINING_LOG_MIN_ENTRIES})`,
        };
      }
      if (parsed.confidence < TRAINING_LOG_MIN_CONFIDENCE) {
        return {
          passed: false,
          reason: `confidence ${parsed.confidence} below ${TRAINING_LOG_MIN_CONFIDENCE} threshold`,
        };
      }
      return { passed: true };
    },
  },
  pm5_screen: {
    prompt: PM5_SCREEN_PROMPT,
    schema: Pm5ScreenResponseSchema,
    threshold: (parsed: Pm5ScreenResponse): ThresholdResult => {
      if (!parsed.is_pm5) {
        return { passed: false, reason: "not a PM5 screen" };
      }
      if (!parsed.completed) {
        return { passed: false, reason: "session not completed" };
      }
      if (parsed.duration_minutes < PM5_MIN_DURATION_MINUTES) {
        return {
          passed: false,
          reason: `duration ${parsed.duration_minutes}min below ${PM5_MIN_DURATION_MINUTES}min threshold`,
        };
      }
      return { passed: true };
    },
  },
};

/**
 * Union of valid subjects in the vision registry. Re-exported so callers
 * (Task 18 vision-verify, downstream orchestration) can constrain their
 * subject parameter without re-deriving the union.
 */
export type VisionSubject = keyof typeof VISION_REGISTRY;
