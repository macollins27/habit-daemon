/**
 * verifyAlignment — judges a free-text daily-alignment submission against the
 * four checkpoint questions and returns a deterministic accept/reject verdict.
 *
 * This is the text analogue of `vision-verify.ts` (which judges proof photos):
 * same shape — build a prompt + JSON schema, dispatch to `claude -p` via an
 * injectable `dispatchImpl`, validate the structured output with Zod, then
 * apply a DETERMINISTIC threshold in code so the accept/reject decision never
 * depends on the model's prose.
 *
 * The point of the habit is to break a rut, so the bar is "substantive,
 * concrete answers", not "four lines of text". The model is instructed to
 * reject the exact low-effort patterns that let you bypass yourself:
 * empty answers, "nothing"/"idk"/"same as yesterday", and abstract one-word
 * answers ("work", "life", "be better") unless expanded into a concrete,
 * physically-doable action. The four questions (verbatim, operator-authored):
 *
 *   1. What am I avoiding?
 *   2. What is the smallest real start today?
 *   3. What are 3 wins today?
 *   4. What habit is interfering today?
 *
 * Fail-closed: any dispatch error, missing output, or schema mismatch returns
 * `accepted: false` — a broken judge must never auto-complete the habit and
 * silence the escalation.
 */

import { z } from "zod";
import { dispatchClaude, type DispatchModel } from "../daemon/sdk-dispatch.js";
import { parseClaudeEnvelope } from "../daemon/verify-footer.js";

/** Mirrors vision-verify's DispatchResult contract. */
export interface DispatchResult {
  readonly structured_output?: unknown;
  readonly error?: string;
}

export interface VerifyAlignmentOptions {
  /** The raw submission text (Discord message or, later, an inbound SMS). */
  readonly text: string;
  /** Test seam. Production callers leave this unset. */
  readonly dispatchImpl?: (opts: {
    prompt: string;
    jsonSchema: string;
  }) => Promise<DispatchResult>;
}

export interface VerifyAlignmentResult {
  readonly accepted: boolean;
  /** Non-empty when `accepted === false`. */
  readonly reason?: string;
  /** The validated judge payload, for audit / rejection-callout text. */
  readonly parsed?: AlignmentVerdict;
}

/**
 * Per-question judgement. `addressed` = the question was answered at all;
 * `substantive` = the answer is concrete and specific (not a low-effort
 * dodge). `wins.count` is the number of distinct wins detected (need >= 3).
 */
const questionSchema = z.object({
  addressed: z.boolean(),
  substantive: z.boolean(),
});

const alignmentSchema = z.object({
  avoiding: questionSchema,
  start: questionSchema,
  wins: z.object({
    addressed: z.boolean(),
    count: z.number().int().min(0),
    substantive: z.boolean(),
  }),
  interfering: questionSchema,
  /** Short human-readable reason; empty string when everything passes. */
  rejection_reason: z.string(),
});

export type AlignmentVerdict = z.infer<typeof alignmentSchema>;

const REQUIRED_WINS = 3;

const DEFAULT_MODEL: DispatchModel = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_BUDGET_USD = 0.1;

const JUDGE_PROMPT = `You are the strict gatekeeper for a daily-alignment checkpoint whose whole purpose is to break the user out of an 8-month rut. The user must answer FOUR questions with concrete, specific, physically-doable answers before they are allowed to start their day. Your job is to judge their submission and REJECT low-effort attempts to bypass the checkpoint.

The four questions:
1. What am I avoiding?  (must name a specific action they could physically do — "calling the billing office", "opening the repo I'm scared is broken" — NOT abstractions like "my life", "work", "stuff")
2. What is the smallest real start today?  (must be a tiny concrete physical next action — "put shoes on and walk outside 5 min", "eat one real meal before caffeine" — NOT identity goals like "go to the gym", "fix my diet")
3. What are 3 wins today?  (must list at least THREE distinct, concrete wins for today)
4. What habit is interfering today?  (must name one specific interfering loop — "opening AI before deciding the day" — NOT "being lazy")

REJECT as NOT substantive: empty answers; "nothing"; "idk"; "n/a"; "same as yesterday"; single abstract words like "work", "life", "be better", "everything" unless expanded into a concrete action; answers that restate the question.

Evaluate the submission below. For each question set addressed=true only if the user actually tried to answer it, and substantive=true only if the answer meets the concreteness bar above. For wins, also report the count of distinct concrete wins. Put a short, specific rejection_reason (what's missing or too vague) when anything fails; empty string if all four pass.

Submission:
"""
{SUBMISSION}
"""`;

function toClaudeJsonSchema(schema: z.ZodTypeAny): string {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json["$schema"];
  return JSON.stringify(json);
}

async function defaultDispatchImpl(opts: {
  prompt: string;
  jsonSchema: string;
}): Promise<DispatchResult> {
  const result = dispatchClaude({
    model: DEFAULT_MODEL,
    prompt: opts.prompt,
    jsonSchema: opts.jsonSchema,
    allowedTools: [],
    // Match dispatchClaudeForCheckin's budget: user/project skills can inject
    // a tool_use turn, so allow a few turns before the structured-output compose.
    maxTurns: 3,
    maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
  });
  if (result.status !== "success" && result.status !== "dry_run") {
    return {
      error: `claude -p exited with status ${result.status} (exitCode ${result.exitCode}): ${result.stderr}`,
    };
  }
  const env = parseClaudeEnvelope(result.stdout);
  if (!env.ok) {
    return { error: `envelope parse failed: ${env.error}` };
  }
  return { structured_output: env.envelope.structured_output };
}

/**
 * Compose a deterministic rejection reason from the verdict when the model
 * didn't supply one (or to make the failure precise).
 */
function deriveReason(v: AlignmentVerdict): string {
  if (v.rejection_reason.trim().length > 0) return v.rejection_reason.trim();
  const missing: string[] = [];
  if (!v.avoiding.addressed || !v.avoiding.substantive) {
    missing.push("what you're avoiding (name a concrete action)");
  }
  if (!v.start.addressed || !v.start.substantive) {
    missing.push("the smallest real start (one tiny physical action)");
  }
  if (!v.wins.addressed || v.wins.count < REQUIRED_WINS || !v.wins.substantive) {
    missing.push(`three concrete wins (got ${String(v.wins.count)})`);
  }
  if (!v.interfering.addressed || !v.interfering.substantive) {
    missing.push("the interfering habit (one specific loop)");
  }
  return missing.length > 0
    ? `Incomplete or too vague: ${missing.join("; ")}.`
    : "Rejected.";
}

/**
 * Judge a daily-alignment submission. Accept ONLY when all four questions are
 * addressed substantively and at least three concrete wins are listed.
 */
export async function verifyAlignment(
  opts: VerifyAlignmentOptions,
): Promise<VerifyAlignmentResult> {
  if (typeof opts.text !== "string" || opts.text.trim().length === 0) {
    return { accepted: false, reason: "Empty submission." };
  }

  const prompt = JUDGE_PROMPT.replace("{SUBMISSION}", opts.text);
  const jsonSchema = toClaudeJsonSchema(alignmentSchema);
  const dispatch = opts.dispatchImpl ?? defaultDispatchImpl;

  const result = await dispatch({ prompt, jsonSchema });

  if (result.error !== undefined) {
    return { accepted: false, reason: `judge failed: ${result.error}` };
  }
  if (result.structured_output === undefined) {
    return { accepted: false, reason: "judge returned no structured_output" };
  }

  const parsed = alignmentSchema.safeParse(result.structured_output);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { accepted: false, reason: `schema validation failed: ${issues}` };
  }

  const v = parsed.data;
  const accepted =
    v.avoiding.addressed &&
    v.avoiding.substantive &&
    v.start.addressed &&
    v.start.substantive &&
    v.wins.addressed &&
    v.wins.count >= REQUIRED_WINS &&
    v.wins.substantive &&
    v.interfering.addressed &&
    v.interfering.substantive;

  return accepted
    ? { accepted: true, parsed: v }
    : { accepted: false, parsed: v, reason: deriveReason(v) };
}
