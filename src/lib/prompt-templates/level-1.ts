// Task 24: L1 habit-checkin template (voice rules + output schema).
//
// L1 is the warm-friend opener: brief, plain English, no WHY content
// (no stakes well, no body data, no patterns). The model produces a one or
// two sentence message and a suggested next_check_in_iso (the orchestrator
// computes the actual escalation time per-habit and ignores the model's
// suggestion in Phase A).
//
// Source: docs/plans/2026-05-12-habit-daemon-design.md § 3 — "Warm, brief,
// no why." The next-action phrasing is proof_type-aware (see voice rules
// below) — auto-sync habits like Concept2 don't ask the user to send
// anything; photo-required habits do; typed-reply habits invite a line back.
//
// The output schema is built from a Zod schema and rendered as a JSON Schema
// string with the `$schema` root field stripped — same regression-history
// caveat as src/daemon/footer-schema.ts:footerSchemaJson().
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 24
//   - src/lib/prompt-builder.ts (consumes LevelTemplate)
//   - src/daemon/footer-schema.ts ($schema strip rationale)

import { z } from "zod";
import type { LevelTemplate } from "../prompt-builder.js";

const L1_OUTPUT_SCHEMA = z.object({
  message_text: z
    .string()
    .min(1)
    .describe("The plain-English warm-friend prompt to send to the user."),
  next_check_in_iso: z
    .string()
    .describe(
      "ISO 8601 timestamp the model suggests as the next check-in. The " +
        "orchestrator computes the actual escalation time per habit and " +
        "ignores this field in Phase A; it is still required so the model " +
        "thinks explicitly about cadence.",
    ),
});

function l1OutputSchemaString(): string {
  const json = z.toJSONSchema(L1_OUTPUT_SCHEMA) as Record<string, unknown>;
  delete json["$schema"];
  return JSON.stringify(json);
}

const L1_VOICE_RULES = `Voice rules for L1 (warm-friend opener):

- Plain English. No marketing register, no motivational-poster phrasing.
- Warm-friend tone — think a close friend sending a one-line nudge, not a coach.
- Brief: ONE or TWO sentences. Stop there.
- NO why content. Do NOT mention stakes, body data, sleep numbers, HRV, or pattern
  observations. L1 is the friendly opener — the WHY wells fire only at L3 and L4.
- Reference the habit naturally by what it is (e.g. "Row time", "lifts", "wind down")
  rather than by the database id.
- Tailor the message to the habit's proof_type (shown in the Habit context block above):
    * "concept2_api+photo_fallback" (e.g. morning-row) — proof is automatic via the
      Concept2 API when the PM5 saves the session. Do NOT ask the user to send a
      photo or anything else. Just nudge them to start. The system picks it up.
    * "training_log_photo" (e.g. strength-mwf) — proof IS a photo of the training log.
      Mention the photo as the natural next action.
    * "typed_msg+garmin_sleep" (e.g. wind-down) — proof is a one-line typed reply
      ("in bed", "winding down", whatever phrase matches the proof_config); the
      sleep data comes from Garmin automatically. Invite the line.
    * Unknown proof_type — keep the message generic; no specific next action.
- Never invent a proof mechanism that isn't supported by the habit's proof_type.

Output: a JSON object with two fields:
  - message_text: the plain-English prompt string (1-2 sentences).
  - next_check_in_iso: your suggested next check-in time as an ISO 8601 string.

Examples (matching the actual proof_type):
  - morning-row (concept2_api+photo_fallback): "Morning Max. Row time — I'll pick up the session from Concept2 when you save."
  - strength-mwf (training_log_photo): "Hey, lift session. Snap the training log when you're done."
  - wind-down (typed_msg+garmin_sleep): "Wind-down time — ping me when you're in bed."`;

export const LEVEL_1_TEMPLATE: LevelTemplate = {
  levelName: "L1",
  voiceRules: L1_VOICE_RULES,
  outputSchema: l1OutputSchemaString(),
};
