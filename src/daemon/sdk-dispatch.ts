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
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function buildDryRunStub(opts: DispatchOpts): DispatchResult {
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
    };
  }
  return {
    status: result.status === 0 ? "success" : "failed",
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs,
    dryRun: false,
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
  // NOTE: --bare is intentionally OMITTED. Per claude --help: "--bare ...
  // Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via
  // --settings (OAuth and keychain are never read)." Founder uses Max plan
  // OAuth via interactive `claude login`; --bare blocks that auth path.
  // When founder migrates to ANTHROPIC_API_KEY (e.g., when --bare becomes
  // default for -p in a future release), add --bare back here.
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
  const args: string[] = [
    "claude",
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
    "--setting-sources",
    "user,project",
    "-p",
    opts.prompt,
  ];
  if (opts.mcpConfigPath !== undefined) {
    args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
  }
  if (opts.appendSystemPromptFile !== undefined) {
    args.push("--append-system-prompt-file", opts.appendSystemPromptFile);
  }

  const start = Date.now();
  const result = spawnSync("/usr/bin/env", args, {
    cwd: opts.cwd,
    encoding: "utf8",
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
    };
  }
  return {
    status: result.status === 0 ? "success" : "failed",
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs,
    dryRun: false,
  };
}
