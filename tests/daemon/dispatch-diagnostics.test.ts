// Regression tests for the dispatch diagnostics layer.
//
// THE INCIDENT (2026-07-31): habit check-in delivery was dead from 2026-05-18
// to 2026-07-31 — 135 runs parked, 1,083 dispatch failures, zero messages —
// and nobody could see why. The recorded error was built as
//
//     stderr=${stderr.slice(0, 600)} | stdout=${stdout.slice(0, 600)}
//
// The failing invocation writes NOTHING to stderr; the whole story is in the
// stdout JSON envelope, where `"result"` begins at character 670 of 788. Sliced
// at 600, the one field naming the cause — "Credit balance is too low" — was
// cut off by seventy characters. Ten weeks of failures each recorded proof that
// something broke and no trace of what.
//
// These tests exist so that can never recur: the diagnostic is PARSED, not
// sliced, and the payload below deliberately places the cause past character
// 600 so a reintroduced truncation fails here first.

import { describe, expect, it } from "vitest";
import {
  classifyDispatchFailure,
  formatDiagnostic,
  summariseDispatch,
  type DispatchLikeResult,
} from "../../src/daemon/dispatch-diagnostics.js";

/** The real envelope observed on 2026-07-31, reproduced under launchd. */
const CREDIT_EXHAUSTED_STDOUT = JSON.stringify({
  is_error: true,
  duration_api_ms: 0,
  num_turns: 1,
  stop_reason: "stop_sequence",
  session_id: "f4d63baa-cdfd-4d95-bea9-70498fb8ec3f",
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: "",
    iterations: [],
    speed: "standard",
  },
  modelUsage: {},
  permission_denials: [],
  terminal_reason: "api_error",
  fast_mode_state: "off",
  fast_mode_disabled_reason: "sdk_opt_in_required",
  subtype: "success",
  api_error_status: 400,
  result: "Credit balance is too low",
  type: "result",
  duration_ms: 332,
  uuid: "f62226a6-933b-4891-b8b6-22af66418802",
});

function failed(stdout: string, stderr = ""): DispatchLikeResult {
  return { status: "failed", exitCode: 1, stdout, stderr, durationMs: 332 };
}

describe("dispatch diagnostics — the 2026-07-31 truncation incident", () => {
  it("the cause really does sit beyond the old 600-character cut", () => {
    // If this ever fails, the fixture stopped reproducing the incident and the
    // test below is no longer proving anything.
    expect(CREDIT_EXHAUSTED_STDOUT.indexOf('"result"')).toBeGreaterThan(600);
  });

  it("captures 'Credit balance is too low' instead of cutting it off", () => {
    const d = summariseDispatch(failed(CREDIT_EXHAUSTED_STDOUT), "api_key_bare");
    expect(d.resultSummary).toBe("Credit balance is too low");
    expect(d.errorCategory).toBe("credit_exhausted");
    expect(d.apiErrorStatus).toBe(400);
    expect(d.terminalReason).toBe("api_error");
  });

  it("records every field the incident review required", () => {
    const d = summariseDispatch(failed(CREDIT_EXHAUSTED_STDOUT), "api_key_bare");
    expect(d.exitCode).toBe(1);
    expect(d.terminalReason).toBe("api_error");
    expect(d.apiErrorStatus).toBe(400);
    expect(d.errorCategory).toBe("credit_exhausted");
    expect(d.modelRequestBegan).toBe(false);
    expect(d.authMode).toBe("api_key_bare");
    expect(typeof d.at).toBe("string");
    expect(Number.isNaN(Date.parse(d.at))).toBe(false);
  });

  it("distinguishes a request that never reached the model from one that did", () => {
    const began = summariseDispatch(
      failed(JSON.stringify({
        is_error: true,
        terminal_reason: "budget_exhausted",
        usage: { input_tokens: 10, output_tokens: 0 },
        duration_api_ms: 412,
      })),
      "subscription",
    );
    expect(began.modelRequestBegan).toBe(true);
    expect(began.errorCategory).toBe("budget_exhausted");

    const neverBegan = summariseDispatch(failed(CREDIT_EXHAUSTED_STDOUT), "api_key_bare");
    expect(neverBegan.modelRequestBegan).toBe(false);
  });

  it("the formatted line leads with the cause, not with the exit code", () => {
    const line = formatDiagnostic(
      summariseDispatch(failed(CREDIT_EXHAUSTED_STDOUT), "api_key_bare"),
    );
    expect(line).toContain("credit_exhausted");
    expect(line).toContain("Credit balance is too low");
    expect(line.indexOf("credit_exhausted")).toBeLessThan(line.indexOf("exit="));
  });

  it("redacts credential-shaped strings from retained raw output", () => {
    const leaky = `boom sk-ant-api03-${"A".repeat(80)} and Bearer ${"B".repeat(40)}`;
    const d = summariseDispatch(failed("not json at all", leaky), "api_key_bare");
    expect(d.rawTail).not.toContain("sk-ant-api03-AAAA");
    expect(d.rawTail).toContain("[REDACTED]");
    expect(JSON.stringify(d)).not.toContain("BBBBBBBBBB");
  });

  it("bounds retained raw output rather than storing an unbounded blob", () => {
    const d = summariseDispatch(failed("x".repeat(50_000)), "api_key_bare");
    expect(d.rawTail).not.toBeNull();
    expect((d.rawTail as string).length).toBeLessThanOrEqual(1_100);
  });

  it("survives unparseable output without throwing", () => {
    const d = summariseDispatch(failed("<html>gateway timeout</html>"), "subscription");
    expect(d.errorCategory).toBe("unparseable_output");
    expect(d.exitCode).toBe(1);
    expect(d.rawTail).toContain("gateway timeout");
  });

  it("classifies the failure modes the global breaker has to act on", () => {
    expect(classifyDispatchFailure({ apiErrorStatus: 400, resultSummary: "Credit balance is too low" }))
      .toBe("credit_exhausted");
    expect(classifyDispatchFailure({ apiErrorStatus: 401, resultSummary: "invalid x-api-key" }))
      .toBe("auth_invalid");
    expect(classifyDispatchFailure({ apiErrorStatus: 403, resultSummary: "forbidden" }))
      .toBe("auth_invalid");
    expect(classifyDispatchFailure({ apiErrorStatus: 429, resultSummary: "rate limit" }))
      .toBe("rate_limited");
    expect(classifyDispatchFailure({ apiErrorStatus: 529, resultSummary: "overloaded" }))
      .toBe("provider_unavailable");
    expect(classifyDispatchFailure({ terminalReason: "budget_exhausted" }))
      .toBe("budget_exhausted");
    expect(classifyDispatchFailure({ status: "timeout" })).toBe("timeout");
    expect(classifyDispatchFailure({ exitCode: 127 })).toBe("cli_unavailable");
  });

  it("treats every account-wide category as global, and per-run ones as not", () => {
    const global_ = ["credit_exhausted", "auth_invalid", "rate_limited", "provider_unavailable", "cli_unavailable"];
    const perRun = ["budget_exhausted", "schema_invalid", "unparseable_output", "unknown"];
    for (const c of global_) expect(isGlobalDependencyFailure(c)).toBe(true);
    for (const c of perRun) expect(isGlobalDependencyFailure(c)).toBe(false);
  });
});

// imported late so the test above reads top-down
import { isGlobalDependencyFailure } from "../../src/daemon/dispatch-diagnostics.js";
