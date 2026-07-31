// Spawn a single `claude -p` subprocess with the canonical flag set
// (--bare, --output-format json, --json-schema, --model, --max-turns,
// --max-budget-usd, --allowedTools, optionally --mcp-config, optionally
// --append-system-prompt-file).
//
// HABIT_DRY_RUN=1 short-circuits actual subprocess invocation and returns a
// stub success envelope so the surrounding pipeline (footer parser, ledger
// write, hash chain append) can be validated end-to-end without consuming
// Max-plan tokens.
//
// Lint discipline: spawnSync uses `/usr/bin/env claude` as the literal first
// argument so security/detect-child-process accepts it. CLAUDE_BIN is checked
// up-front by bin/dispatch via env.sh (check_claude_bin); the TS layer relies
// on `claude` being on PATH at this point.
//
// Future v0.2: swap raw spawnSync for @anthropic-ai/claude-agent-sdk
// query() to gain session-resume, fork, and live stream-json events.
//
// References:

import { spawnSync } from "node:child_process";
import type { DispatchAuthMode } from "./dispatch-diagnostics.js";
import { query as anthropicQuery, AbortError } from "@anthropic-ai/claude-agent-sdk";

export type DispatchModel = "claude-opus-4-7" | "claude-sonnet-4-6" | "claude-haiku-4-5-20251001";

export interface DispatchOpts {
  readonly model: DispatchModel;
  readonly prompt: string;
  /** JSON-stringified JSON Schema; usually footerSchemaJson() */
  readonly jsonSchema: string;
  readonly allowedTools: readonly string[];
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly mcpConfigPath?: string;
  readonly appendSystemPromptFile?: string;
  readonly cwd?: string;
  /** Hard wall-clock cap in ms. Default 30 min. */
  readonly timeoutMs?: number;
}

export type DispatchStatus = "success" | "failed" | "timeout" | "dry_run";

export interface DispatchResult {
  readonly status: DispatchStatus;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly dryRun: boolean;
  /** Which credential path this invocation actually used. Recorded so a
   *  failure can be attributed to the right account without guessing. */
  readonly authMode: DispatchAuthMode;
}

/**
 * Which authentication path dispatch uses, from `HABIT_AUTH_MODE`.
 *
 * "bare" (the default, and the historical behaviour) passes `--bare`, which
 * forces API-key auth via ANTHROPIC_API_KEY. "subscription" omits `--bare` and
 * lets the CLI use the operator's normal Claude credentials.
 *
 * The source comment here used to assert that subscription auth "isn't
 * reliable for a daemon" because a launchd job cannot read keychain OAuth
 * tokens. That was never measured, and on 2026-07-31 it was tested directly: a
 * probe running in the same user launchd domain, same HOME, same PATH, same
 * working directory and with no TTY completed successfully 4 times out of 4,
 * returning valid --json-schema structured output. The assumption was wrong,
 * and it had kept the daemon pinned to an API key whose account had no credit
 * for ten weeks.
 */
export function resolveAuthMode(
  env: NodeJS.ProcessEnv = process.env,
): DispatchAuthMode {
  return env["HABIT_AUTH_MODE"] === "subscription"
    ? "subscription"
    : "api_key_bare";
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function buildDryRunStub(opts: DispatchOpts): DispatchResult {
  const authMode = resolveAuthMode();
  // Return a JSON envelope shaped like what `claude -p --output-format json`
  // would emit on success. The structured_output is a minimal CLEAN footer.
  const stubEnvelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: "DRY RUN: dispatch payload validated, no claude -p subprocess invoked",
    session_id: "dry-run-session",
    total_cost_usd: 0,
    structured_output: {
      artifact_path: null,
      write_set: [],
      findings_status: "UNKNOWN",
      confidence: "low",
      scope_risk: "narrow",
      reversibility: "clean",
    },
    dry_run_dispatch_args: {
      model: opts.model,
      max_turns: opts.maxTurns,
      max_budget_usd: opts.maxBudgetUsd,
      allowed_tools: opts.allowedTools,
      mcp_config_path: opts.mcpConfigPath ?? null,
      append_system_prompt_file: opts.appendSystemPromptFile ?? null,
      prompt_first_120_chars: opts.prompt.slice(0, 120),
    },
  };
  return {
    status: "dry_run",
    exitCode: 0,
    stdout: JSON.stringify(stubEnvelope),
    stderr: "",
    durationMs: 1,
    dryRun: true,
    authMode,
  };
}

/**
 * v0.2 SDK substrate stub. When HABIT_USE_SDK=1 in the environment, dispatches
 * route through @anthropic-ai/claude-agent-sdk's `query()` instead of raw
 * spawnSync. Unlocks session-resume / fork / file-checkpointing per design
 * v2 §2.1. The stub currently delegates to dispatchClaude (raw spawn) until
 * the SDK wiring lands; the import keeps the SDK in the dep graph for knip
 * + ensures the SDK's AbortError + query types are available to the swap.
 *
 * @public
 */
export async function dispatchClaudeViaSdk(opts: DispatchOpts): Promise<DispatchResult> {
  if (typeof anthropicQuery !== "function") {
    throw new AbortError("@anthropic-ai/claude-agent-sdk query() not available — install broken");
  }
  return dispatchClaude(opts);
}

function buildSandboxDispatchEnv(opts: DispatchOpts): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HABIT_DISPATCH_PROMPT: opts.prompt,
    HABIT_DISPATCH_JSON_SCHEMA: opts.jsonSchema,
    HABIT_DISPATCH_MODEL: opts.model,
    HABIT_DISPATCH_MAX_TURNS: String(opts.maxTurns),
    HABIT_DISPATCH_MAX_BUDGET: String(opts.maxBudgetUsd),
    HABIT_DISPATCH_ALLOWED_TOOLS: opts.allowedTools.join(","),
    HABIT_DISPATCH_ID: `habit-${Date.now().toString(36)}`,
    ...(opts.mcpConfigPath !== undefined ? { HABIT_DISPATCH_MCP_CONFIG: opts.mcpConfigPath } : {}),
  };
}

function dispatchClaudeViaSandbox(opts: DispatchOpts): DispatchResult {
  const authMode = resolveAuthMode();
  const projectRoot = process.env.PROJECT_ROOT ?? process.cwd();
  const runDispatchPath = `${projectRoot}/scripts/sandbox/run-dispatch.sh`;
  const start = Date.now();
  const result = spawnSync("/bin/bash", [runDispatchPath], {
    cwd: opts.cwd,
    encoding: "utf8",
    env: buildSandboxDispatchEnv(opts),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const durationMs = Date.now() - start;
  if (result.error) {
    return {
      status: "failed",
      exitCode: -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error.message,
      durationMs,
      dryRun: false,
      authMode,
    };
  }
  if (result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    return {
      status: "timeout",
      exitCode: -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs,
      dryRun: false,
      authMode,
    };
  }
  return {
    status: result.status === 0 ? "success" : "failed",
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs,
    dryRun: false,
    authMode,
  };
}

export function dispatchClaude(opts: DispatchOpts): DispatchResult {
  if (process.env.HABIT_DRY_RUN === "1") {
    return buildDryRunStub(opts);
  }
  if (process.env.HABIT_USE_SANDBOX === "1") {
    return dispatchClaudeViaSandbox(opts);
  }

  // First arg is the literal program "claude"; /usr/bin/env handles PATH lookup.
  // --bare: opts into strict API-key auth via ANTHROPIC_API_KEY (or apiKeyHelper
  // via --settings), bypassing the OAuth / keychain fallback. Habit-daemon uses
  // API-key auth per the deployment contract — the ANTHROPIC_API_KEY env var is
  // sourced from ~/.habit-daemon/env at startup. Without --bare, the CLI would
  // attempt to read keychain OAuth tokens from the launchd service user's
  // session, which isn't reliable for a daemon.
  //
  // --setting-sources "user,project": include both user-level (OAuth keychain)
  // and project-level (.claude/skills/, .claude/settings.json hooks) settings.
  // Excludes "local" (.claude/settings.local.json — per-developer overrides
  // not part of the dispatch contract).
  //
  // History: an earlier version used --setting-sources user (project excluded)
  // as a workaround for what I thought was project-settings overriding
  // --json-schema's StructuredOutput injection. Re-investigation confirmed
  // the actual root cause was the $schema field at JSON-Schema root (Anthropic
  // silently rejects schemas containing it; fixed in footer-schema.ts via
  // strip). With $schema stripped, StructuredOutput injects correctly under
  // all --setting-sources values (verified across user / user,project /
  // project / "" combinations). Excluding project skills meant the Skill tool
  // returned "Unknown skill: <name>" for every skill — verified via L2
  // dispatch session 417409d4 tool_result trace. The model improvised work
  // without the skill protocol's mechanical checks (15-grep audit, etc.).
  // user,project restores skill resolution while keeping StructuredOutput.
  const authMode = resolveAuthMode();
  const args: string[] = [
    "claude",
    // --bare forces API-key auth. Omitted under HABIT_AUTH_MODE=subscription so
    // the CLI uses the operator's normal Claude credentials instead.
    ...(authMode === "api_key_bare" ? ["--bare"] : []),
    "--output-format",
    "json",
    "--json-schema",
    opts.jsonSchema,
    "--model",
    opts.model,
    "--max-turns",
    String(opts.maxTurns),
    "--max-budget-usd",
    String(opts.maxBudgetUsd),
    "--allowedTools",
    opts.allowedTools.join(","),
    // 2026-05-13: changed from "user,project" to "" — user-level skills like
    // superpowers:using-superpowers auto-invoke on conversation start, consuming
    // turn budget and producing error_max_turns before the model can compose the
    // structured-output JSON. The habit-checkin + vision-verify prompts don't
    // reference any skill, so empty setting sources is the correct surface here.
    // If a future dispatch type needs skill resolution, add a settingSources opt
    // to DispatchOpts and opt in explicitly.
    "--setting-sources",
    "",
    "-p",
    opts.prompt,
  ];
  if (opts.mcpConfigPath !== undefined) {
    args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
  }
  if (opts.appendSystemPromptFile !== undefined) {
    args.push("--append-system-prompt-file", opts.appendSystemPromptFile);
  }

  // Explicit env propagation: --bare requires ANTHROPIC_API_KEY. Without
  // passing env: process.env, behaviour depends on Node's default-inherit
  // contract; making it explicit also lets a future env-stripping change
  // here be visible.
  if (authMode === "api_key_bare" && process.env.ANTHROPIC_API_KEY === undefined) {
    process.stderr.write(
      `[dispatch-claude] WARNING: ANTHROPIC_API_KEY missing from process.env — claude --bare will fail auth\n`,
    );
  }
  // Under subscription auth the API key must be ABSENT from the child's
  // environment, not merely unused: the CLI will pick up ANTHROPIC_API_KEY on
  // its own even without --bare, which would silently route back to the
  // no-credit account this change exists to stop using. Verified 2026-07-31 —
  // the launchd probe only succeeded with the key unset.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (authMode === "subscription") {
    delete childEnv["ANTHROPIC_API_KEY"];
  }

  const start = Date.now();
  const result = spawnSync("/usr/bin/env", args, {
    cwd: opts.cwd,
    encoding: "utf8",
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const durationMs = Date.now() - start;

  if (result.error) {
    return {
      status: "failed",
      exitCode: -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error.message,
      durationMs,
      dryRun: false,
      authMode,
    };
  }
  if (result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    return {
      status: "timeout",
      exitCode: -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs,
      dryRun: false,
      authMode,
    };
  }
  return {
    status: result.status === 0 ? "success" : "failed",
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs,
    dryRun: false,
    authMode,
  };
}
