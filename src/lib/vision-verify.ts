/**
 * verifyImage — wrapper over `claude -p` that classifies a proof photo
 * against a registered VisionSubject and returns a deterministic pass/fail
 * result with the parsed payload.
 *
 * The wrapper composes three pieces:
 *   1. VISION_REGISTRY (Task 17) — per-subject prompt + Zod schema + threshold.
 *   2. dispatchClaude (Task 3, src/daemon/sdk-dispatch.ts) — the `claude -p`
 *      spawnSync layer that handles --json-schema, --model, --max-turns,
 *      --max-budget-usd, and the DRY_RUN/SANDBOX env switches.
 *   3. parseClaudeEnvelope (src/daemon/verify-footer.ts) — unwraps the
 *      `claude -p --output-format json` envelope and extracts structured_output.
 *
 * For testability the wrapper accepts an injected `dispatchImpl` callback;
 * tests pass mocks so they never invoke a real subprocess. When no impl is
 * provided we fall through to the production default that wires the real
 * dispatchClaude + envelope parser.
 *
 * Image URL handling is the Phase A simplification: we embed the URL in the
 * prompt text and let Claude fetch it if it has that capability. If it does
 * not, the model is expected to surface a rejection_reason in its structured
 * output (which still parses cleanly via the registered Zod schema and then
 * fails the subject's threshold). Revisit in retro.
 *
 * The JSON Schema string passed to claude has its `$schema` root field
 * stripped — Anthropic's tool-input validator silently rejects schemas
 * containing it (see footer-schema.ts:footerSchemaJson() for the full
 * regression history).
 */

import { z } from "zod";
import { VISION_REGISTRY, type VisionSubject } from "./vision-registry.js";
import { dispatchClaude, type DispatchModel } from "../daemon/sdk-dispatch.js";
import { parseClaudeEnvelope } from "../daemon/verify-footer.js";

/**
 * Result returned by a dispatch implementation. Exactly one of the two
 * fields is populated on a given call:
 *   - `structured_output`: the parsed payload extracted from the claude -p
 *     JSON envelope, ready for Zod validation.
 *   - `error`: a short human-readable description of why dispatch failed
 *     (non-zero exit, timeout, envelope parse failure, etc.).
 */
export interface DispatchResult {
  readonly structured_output?: unknown;
  readonly error?: string;
}

export interface VerifyImageOptions {
  readonly imageUrl: string;
  readonly subject: VisionSubject;
  /**
   * Test seam. Production callers leave this unset and the wrapper falls
   * through to the real dispatchClaude + parseClaudeEnvelope chain.
   */
  readonly dispatchImpl?: (opts: {
    prompt: string;
    jsonSchema: string;
  }) => Promise<DispatchResult>;
}

/**
 * The pass/fail verdict from a vision verification. `parsed` is populated
 * whenever the dispatch returned a structurally valid payload, regardless
 * of whether the threshold ultimately passed — callers can persist it for
 * audit / rejection-callout text. `reason` is non-empty when `passed=false`.
 */
export interface VerifyImageResult {
  readonly passed: boolean;
  readonly parsed?: unknown;
  readonly reason?: string;
}

/**
 * Default vision model: Haiku is sufficient for proof-photo classification
 * and ~10x cheaper than Sonnet for this throwaway scoring task. Upgrade
 * later if calibration shows Haiku misclassifies a meaningful fraction of
 * real proof photos.
 */
const DEFAULT_VISION_MODEL: DispatchModel = "claude-haiku-4-5-20251001";

/** Generous cap — vision verify is one short turn, but leave headroom. */
const DEFAULT_MAX_BUDGET_USD = 0.1;

/**
 * Render a Zod schema as a JSON Schema string suitable for
 * `claude -p --json-schema '<json>'`. Strips the `$schema` root field
 * (Anthropic's tool-input validator silently rejects schemas containing it
 * — see footer-schema.ts for the regression history that uncovered this).
 */
function toClaudeJsonSchema(schema: z.ZodTypeAny): string {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json["$schema"];
  return JSON.stringify(json);
}

/**
 * Production dispatchImpl. Wires dispatchClaude + parseClaudeEnvelope and
 * normalizes the result into DispatchResult shape so verifyImage's core
 * stays oblivious to the subprocess layer.
 */
async function defaultDispatchImpl(opts: {
  prompt: string;
  jsonSchema: string;
}): Promise<DispatchResult> {
  const result = dispatchClaude({
    model: DEFAULT_VISION_MODEL,
    prompt: opts.prompt,
    jsonSchema: opts.jsonSchema,
    allowedTools: [],
    maxTurns: 1,
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
 * Verify a proof photo against a registered VisionSubject.
 *
 * Flow:
 *   1. Look up the registry entry for the subject.
 *   2. Build the prompt (image URL prefix + registry prompt).
 *   3. Render the registry's Zod schema as JSON-Schema for --json-schema.
 *   4. Invoke dispatchImpl (test-injected or production default).
 *   5. If dispatch errored or returned no structured_output → fail-closed.
 *   6. Validate structured_output via the registry's schema → fail on issue.
 *   7. Apply the registry's threshold → return its verdict + parsed payload.
 */
export async function verifyImage(opts: VerifyImageOptions): Promise<VerifyImageResult> {
  const entry = VISION_REGISTRY[opts.subject];
  const prompt = `Image to verify: ${opts.imageUrl}\n\n${entry.prompt}`;
  const jsonSchema = toClaudeJsonSchema(entry.schema);
  const dispatch = opts.dispatchImpl ?? defaultDispatchImpl;

  const result = await dispatch({ prompt, jsonSchema });

  if (result.error !== undefined) {
    return { passed: false, reason: `dispatch failed: ${result.error}` };
  }
  if (result.structured_output === undefined) {
    return {
      passed: false,
      reason: "dispatch returned no structured_output",
    };
  }

  const parsed = entry.schema.safeParse(result.structured_output);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      passed: false,
      reason: `schema validation failed: ${issues}`,
    };
  }

  // Discriminate the two registry entries so TypeScript picks the right
  // threshold overload without an `as` cast. Both branches return
  // ThresholdResult from the registry.
  const verdict =
    opts.subject === "pm5_screen"
      ? VISION_REGISTRY.pm5_screen.threshold(parsed.data as never)
      : VISION_REGISTRY.training_log.threshold(parsed.data as never);

  return {
    passed: verdict.passed,
    parsed: parsed.data,
    reason: verdict.reason,
  };
}
