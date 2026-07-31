// Structured diagnostics for `claude -p` dispatch failures.
//
// WHY THIS EXISTS
// ---------------
// Between 2026-05-18 and 2026-07-31 every habit check-in failed and none of the
// 1,083 recorded failures said why. The dispatcher stored its error as
//
//     stderr=${stderr.slice(0, 600)} | stdout=${stdout.slice(0, 600)}
//
// and the failing invocation writes nothing to stderr — the entire explanation
// lives in the stdout JSON envelope, where `"result"` starts at character 670
// of 788. The slice cut the cause off by seventy characters, so ten weeks of
// outage recorded only that something had gone wrong.
//
// The fix is not a bigger slice. A slice is the wrong instrument: the envelope
// is structured data, so it gets parsed, classified and stored field by field.
// Raw output is retained only as a bounded, redacted tail for the cases the
// parser cannot handle.
//
// This module is deliberately free of I/O and of any dependency on the Claude
// CLI itself, so the component that reports a Claude failure never needs Claude
// to be working in order to run.

/** How the dispatch authenticated. Recorded so a failure can be attributed. */
export type DispatchAuthMode = "api_key_bare" | "subscription" | "oauth_token";

/**
 * Failure categories. The split that matters operationally is global vs
 * per-run: a global category means the dependency is down for EVERY run, so
 * retrying each one individually just burns 8 attempts apiece and parks the
 * whole ledger — which is exactly what happened.
 */
export type DispatchErrorCategory =
  | "credit_exhausted"
  | "auth_invalid"
  | "rate_limited"
  | "provider_unavailable"
  | "cli_unavailable"
  | "timeout"
  | "budget_exhausted"
  | "schema_invalid"
  | "unparseable_output"
  | "unknown";

const GLOBAL_CATEGORIES: ReadonlySet<string> = new Set<DispatchErrorCategory>([
  "credit_exhausted",
  "auth_invalid",
  "rate_limited",
  "provider_unavailable",
  "cli_unavailable",
]);

/**
 * True when the category describes the AI dependency being unavailable
 * account-wide rather than something wrong with one particular run.
 */
export function isGlobalDependencyFailure(category: string): boolean {
  return GLOBAL_CATEGORIES.has(category);
}

export interface DispatchLikeResult {
  readonly status: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs?: number;
}

export interface DispatchDiagnostic {
  readonly at: string;
  readonly authMode: DispatchAuthMode;
  readonly status: string;
  readonly exitCode: number;
  readonly terminalReason: string | null;
  readonly apiErrorStatus: number | null;
  readonly resultSummary: string | null;
  readonly errorCategory: DispatchErrorCategory;
  readonly modelRequestBegan: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly durationMs: number | null;
  readonly rawTail: string | null;
}

const RAW_TAIL_LIMIT = 1_000;
const RESULT_SUMMARY_LIMIT = 300;

/**
 * Redact credential-shaped substrings. This runs on output we did not author,
 * so it is deliberately aggressive: a false redaction costs a little context,
 * a missed one writes a live secret into the ledger.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(x-api-key|api[_-]?key|authorization|token|secret)\b(\s*[:=]\s*)("?)[A-Za-z0-9._-]{8,}\3/gi,
             "$1$2[REDACTED]");
}

export function classifyDispatchFailure(signals: {
  readonly apiErrorStatus?: number | null;
  readonly resultSummary?: string | null;
  readonly terminalReason?: string | null;
  readonly status?: string | null;
  readonly exitCode?: number | null;
  readonly parsed?: boolean;
}): DispatchErrorCategory {
  const text = (signals.resultSummary ?? "").toLowerCase();
  const status = signals.apiErrorStatus ?? null;

  if (signals.status === "timeout") return "timeout";
  if (signals.exitCode === 127) return "cli_unavailable";

  // Credit exhaustion arrives as a 400 whose message names it. Checked before
  // the generic 400 handling because it is the one an operator must act on.
  if (text.includes("credit balance") || text.includes("insufficient credit")) {
    return "credit_exhausted";
  }
  if (status === 401 || status === 403) return "auth_invalid";
  if (text.includes("invalid x-api-key") || text.includes("authentication")) {
    return "auth_invalid";
  }
  if (status === 429) return "rate_limited";
  if (text.includes("rate limit") || text.includes("usage limit")) return "rate_limited";
  if (status === 500 || status === 502 || status === 503 || status === 529) {
    return "provider_unavailable";
  }
  if (text.includes("overloaded")) return "provider_unavailable";

  if (signals.terminalReason === "budget_exhausted") return "budget_exhausted";
  if (signals.terminalReason === "error_max_turns") return "schema_invalid";
  if (signals.parsed === false) return "unparseable_output";
  return "unknown";
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse a `claude -p --output-format json` envelope into a diagnostic record.
 * Never throws: a dispatcher that crashes while explaining a crash is worse
 * than the original fault.
 */
export function summariseDispatch(
  result: DispatchLikeResult,
  authMode: DispatchAuthMode,
  now: Date = new Date(),
): DispatchDiagnostic {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate: unknown = JSON.parse(stdout);
    if (candidate !== null && typeof candidate === "object") {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }

  const usage = (parsed?.["usage"] ?? {}) as Record<string, unknown>;
  const inputTokens = asNumber(usage["input_tokens"]);
  const outputTokens = asNumber(usage["output_tokens"]);
  const durationApiMs = asNumber(parsed?.["duration_api_ms"]);

  const terminalReason =
    typeof parsed?.["terminal_reason"] === "string"
      ? (parsed["terminal_reason"] as string)
      : null;
  const apiErrorStatus = asNumber(parsed?.["api_error_status"]);
  const rawResult = parsed?.["result"];
  const resultSummary =
    typeof rawResult === "string"
      ? redactSecrets(rawResult).slice(0, RESULT_SUMMARY_LIMIT)
      : null;

  const errorCategory = classifyDispatchFailure({
    apiErrorStatus,
    resultSummary,
    terminalReason,
    status: result.status,
    exitCode: result.exitCode,
    parsed: parsed !== null,
  });

  // "Did we actually reach the model?" separates a billing/auth wall (no) from
  // a budget or turn limit (yes). Zero tokens alone proves neither — this is
  // the distinction the first incident report got wrong.
  const modelRequestBegan = (inputTokens ?? 0) > 0 || (durationApiMs ?? 0) > 0;

  // Retain raw output only where it still carries information: an unparseable
  // stdout, or a stderr the parser cannot represent.
  const rawSource = parsed === null ? `${stderr}\n${stdout}`.trim() : stderr.trim();
  const rawTail =
    rawSource.length > 0
      ? redactSecrets(rawSource).slice(0, RAW_TAIL_LIMIT)
      : null;

  return {
    at: now.toISOString(),
    authMode,
    status: result.status,
    exitCode: result.exitCode,
    terminalReason,
    apiErrorStatus,
    resultSummary,
    errorCategory,
    modelRequestBegan,
    inputTokens,
    outputTokens,
    durationMs: asNumber(result.durationMs),
    rawTail,
  };
}

/**
 * One compact line for logs and for `habit_runs.last_dispatch_error`'s human
 * half. The CAUSE comes first: the old format led with the exit code and buried
 * the reason past a truncation boundary.
 */
export function formatDiagnostic(d: DispatchDiagnostic): string {
  const bits = [
    d.errorCategory,
    d.resultSummary !== null ? `"${d.resultSummary}"` : null,
    d.apiErrorStatus !== null ? `api_status=${String(d.apiErrorStatus)}` : null,
    d.terminalReason !== null ? `terminal=${d.terminalReason}` : null,
    `auth=${d.authMode}`,
    `model_request_began=${String(d.modelRequestBegan)}`,
    `exit=${String(d.exitCode)}`,
    `at=${d.at}`,
  ].filter((x): x is string => x !== null);
  return bits.join(" | ");
}

/** The value stored in `habit_runs.last_dispatch_error` — structured, queryable. */
export function serialiseDiagnostic(d: DispatchDiagnostic): string {
  return JSON.stringify(d);
}
