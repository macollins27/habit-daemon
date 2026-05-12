// Task 31: L5 habit-checkin template — the terminal "logged as missed"
// message.
//
// L5 is the FINAL escalation step. The voice is factual closure: name the
// miss, signal the end of today's run, point forward to tomorrow's
// conversation (the Phase B post-miss interview). There is NO new WHY
// content (the WHY was deployed at L3, called out at L4), and NO future
// check-in framing — this run is over.
//
// Design § 3 captures the canonical example:
//
//   "L5 posts final message, sets `status='missed'`, halts."
//   Example: "Logged as missed. We'll talk tomorrow."
//
// The output schema mirrors L1/L2/L4's (one message_text + one
// next_check_in_iso). The `next_check_in_iso` is ignored by the verb at L5
// — there is no next escalation — but the schema stays identical so the
// shared validator in habit-checkin.ts does not need a per-level branch.
// We document the irrelevance in the field description so the model knows
// the value will be discarded.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 31
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 (escalation voice)
//   - src/lib/prompt-templates/level-4.ts (mirrored shape)

import { z } from "zod";
import type { LevelTemplate } from "../prompt-builder.js";

const L5_OUTPUT_SCHEMA = z.object({
  message_text: z
    .string()
    .min(1)
    .describe(
      "The plain-English terminal closure message to send to the user.",
    ),
  next_check_in_iso: z
    .string()
    .describe(
      "ISO 8601 placeholder. L5 is the terminal escalation — the " +
        "orchestrator sets next_escalation_at = NULL and ignores this " +
        "field. The schema keeps it for shape parity with L1-L4; emit any " +
        "valid ISO 8601 string.",
    ),
});

function l5OutputSchemaString(): string {
  const json = z.toJSONSchema(L5_OUTPUT_SCHEMA) as Record<string, unknown>;
  delete json["$schema"];
  return JSON.stringify(json);
}

const L5_VOICE_RULES = `Voice rules for L5 (final / terminal closure):

- THIS IS THE LAST MESSAGE of today's run. The run is closing. The next
  conversation will be tomorrow's post-miss interview, NOT another
  check-in. Frame this as closure, not continuation.
- Acknowledge the miss factually. No drama. No moralizing. No shame.
- Brief: ONE sentence ideally, two at most. "Logged as missed. We'll talk
  tomorrow." level — that short, that flat.
- Plain English. No marketing register, no motivational-poster phrasing.
- NO new WHY content. The WHY was deployed at L3 and the callout fired at
  L4. Do NOT repeat stakes, do NOT cite body data (sleep, HRV), do NOT
  name pattern observations, and do NOT introduce any new motivational
  framing. L5 is closure only.
- Do NOT promise a follow-up time, do NOT ask a question, do NOT request
  a reply. The user does not need to respond to this message — tomorrow's
  post-miss interview is a separate verb.
- Reference the habit naturally by what it is (e.g. "row", "lifts") only
  if the message needs disambiguation; the channel makes the habit
  obvious, so habit naming is optional at L5.

Output: a JSON object with two fields:
  - message_text: the plain-English terminal closure (1-2 sentences).
  - next_check_in_iso: any valid ISO 8601 string. The orchestrator ignores
    this field at L5; it is required only for schema parity with L1-L4.

Example for morning-row: "Logged as missed. We'll talk tomorrow."
Example for strength-mwf: "Lifts logged as missed. Tomorrow."`;

export const LEVEL_5_TEMPLATE: LevelTemplate = {
  levelName: "L5",
  voiceRules: L5_VOICE_RULES,
  outputSchema: l5OutputSchemaString(),
};
