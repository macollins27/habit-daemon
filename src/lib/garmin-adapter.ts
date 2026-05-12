// Task 13: Node bridge to scripts/garmin_fetch.py.
//
// The daemon never imports garminconnect directly — that library has been
// installed into ~/.habit-daemon/venv per ADR 0003 and is invoked through
// scripts/garmin_fetch.py. This module is the only place in the Node side
// that knows how to spawn that script, marshal its arguments, and translate
// its exit codes (0/1/2/3) into typed Node-side outcomes.
//
// Exit-code contract (mirrored from the Python shim):
//   0  success: stdout is JSON. `{}` means "no data for this date" → null.
//   1  usage error: the bridge is calling the script wrong → bug on our side
//      → GarminBridgeError.
//   2  auth expired / tokens missing → GarminAuthExpired. Caller (Task 16's
//      retry-unresolved-sensors) should surface this to the user via the
//      claude-agent callout so they can re-run `garmin-auth login`.
//   3  network or API failure → GarminNetworkError. Caller should keep the
//      sensor row marked unresolved and retry on the next poll.
//
// A `spawnImpl` injection point exists so the unit tests can exercise every
// exit-code branch without spawning real processes. Production code passes
// nothing and gets the real node:child_process spawnSync.
//
// fetchSleep() is async-returning even though spawnSync is synchronous: we
// reserve the right to switch to spawn() / fork() later without breaking
// callers. The await also lets the daemon's scheduler interleave shim calls
// with other work without blocking the event loop on slow spawns once we
// move to the async variant.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface GarminSleep {
  readonly sleep_onset_time: string | null;
  readonly total_sleep_minutes: number | null;
  readonly rem_minutes: number | null;
  readonly deep_sleep_minutes: number | null;
  readonly hrv: number | null;
}

// The shape of a spawnSync result that we actually rely on. Extracted so
// tests can synthesize one without importing node:child_process internals.
export interface SpawnResultLike {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export type SpawnImpl = (
  cmd: string,
  args: readonly string[],
  opts: { readonly encoding: "utf8" },
) => SpawnResultLike;

// Error classes. Each carries the unmodified stderr from the Python shim so
// the daemon's log captures the underlying cause. Using `extends Error` plus
// a readonly `name` makes `err instanceof GarminAuthExpired` reliable across
// the Node-test boundary (no Symbol.hasInstance gymnastics required).

export class GarminAuthExpired extends Error {
  override readonly name = "GarminAuthExpired" as const;
}

export class GarminNetworkError extends Error {
  override readonly name = "GarminNetworkError" as const;
}

export class GarminBridgeError extends Error {
  override readonly name = "GarminBridgeError" as const;
}

// Canonical sleep field set per the habit-daemon design (body_data_well's
// relevant_signals). Mirrors STUB_PAYLOAD's keys in garmin_fetch.py.
const DEFAULT_FIELDS: readonly string[] = [
  "sleep_onset_time",
  "total_sleep_minutes",
  "rem_minutes",
  "deep_sleep_minutes",
  "hrv",
];

// Resolve default script path relative to this compiled file. Both
// src/lib/garmin-adapter.ts and dist/lib/garmin-adapter.js live two levels
// below the repo root, so `../../scripts/garmin_fetch.py` works in either
// location. Computed once at module load.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT_PATH = resolve(
  MODULE_DIR,
  "..",
  "..",
  "scripts",
  "garmin_fetch.py",
);

// Default Python interpreter. We compute this at call time (not module load)
// so HOME changes between calls — common in tests — are respected.
function defaultPythonBin(): string {
  return resolve(homedir(), ".habit-daemon", "venv", "bin", "python");
}

export interface FetchSleepOptions {
  readonly date: string;
  readonly pythonBin?: string;
  readonly scriptPath?: string;
  readonly stub?: boolean;
  readonly fields?: readonly string[];
  readonly spawnImpl?: SpawnImpl;
}

// Real-spawn adapter: tighten the spawnSync result to the SpawnResultLike
// shape and coerce Buffer→string. Tests bypass this by passing a synthetic
// SpawnImpl directly.
function defaultSpawnImpl(
  cmd: string,
  args: readonly string[],
): SpawnResultLike {
  const result = spawnSync(cmd, [...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error,
  };
}

function buildArgs(
  pythonBin: string,
  scriptPath: string,
  date: string,
  fields: readonly string[],
  stub: boolean,
): { cmd: string; args: readonly string[] } {
  // Invoke through /usr/bin/env so callers can pass either a bare command
  // ("python3") or an absolute path; env handles both. This matches the
  // shebang style used inside scripts/garmin_fetch.py.
  const cmd = "/usr/bin/env";
  const args: string[] = [pythonBin, scriptPath];
  if (stub) {
    args.push("--stub");
  }
  args.push("--date", date, "--fields", fields.join(","));
  return { cmd, args };
}

function projectSleep(raw: Record<string, unknown>): GarminSleep {
  // Any missing or non-matching field is coerced to null so the GarminSleep
  // type stays strict. Numeric fields require typeof number; string fields
  // require typeof string. Anything unexpected → null. This is defensive
  // because the Python shim's projection drops missing fields entirely
  // rather than emitting nulls.
  const stringOrNull = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  const numberOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    sleep_onset_time: stringOrNull(raw.sleep_onset_time),
    total_sleep_minutes: numberOrNull(raw.total_sleep_minutes),
    rem_minutes: numberOrNull(raw.rem_minutes),
    deep_sleep_minutes: numberOrNull(raw.deep_sleep_minutes),
    hrv: numberOrNull(raw.hrv),
  };
}

export async function fetchSleep(
  opts: FetchSleepOptions,
): Promise<GarminSleep | null> {
  const pythonBin = opts.pythonBin ?? defaultPythonBin();
  const scriptPath = opts.scriptPath ?? DEFAULT_SCRIPT_PATH;
  const fields = opts.fields ?? DEFAULT_FIELDS;
  const stub = opts.stub ?? false;
  const spawnImpl = opts.spawnImpl ?? defaultSpawnImpl;

  const { cmd, args } = buildArgs(
    pythonBin,
    scriptPath,
    opts.date,
    fields,
    stub,
  );

  const result = spawnImpl(cmd, args, { encoding: "utf8" });

  const stderr = (result.stderr ?? "").trim();

  // status === null indicates the child never started (interpreter missing,
  // permission denied, etc.). spawnSync usually attaches an Error in
  // result.error in that case.
  if (result.status === null) {
    const cause = result.error?.message ?? "unknown";
    throw new GarminBridgeError(`failed to spawn python: ${cause}`);
  }

  if (result.status === 2) {
    throw new GarminAuthExpired(
      stderr.length > 0 ? stderr : "Garmin auth expired",
    );
  }

  if (result.status === 3) {
    throw new GarminNetworkError(
      stderr.length > 0 ? stderr : "Garmin network error",
    );
  }

  if (result.status === 1) {
    throw new GarminBridgeError(`garmin_fetch.py usage error: ${stderr}`);
  }

  if (result.status !== 0) {
    throw new GarminBridgeError(
      `garmin_fetch.py exited with unexpected status ${result.status}: ${stderr}`,
    );
  }

  // Status 0: parse stdout JSON. An empty `{}` signals "no data for this
  // date" per the shim contract and is normalized to null here.
  const stdout = (result.stdout ?? "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new GarminBridgeError(
      `garmin_fetch.py stdout was not valid JSON: ${cause}`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new GarminBridgeError(
      "garmin_fetch.py stdout was not a JSON object",
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).length === 0) {
    return null;
  }

  return projectSleep(obj);
}
