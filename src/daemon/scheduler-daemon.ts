// scripts/orchestrate/scheduler-daemon.ts
//
// Long-running scheduler entry point. Run via systemd (canonical) or
// supervisord / pm2 (alternative). Polls the schedules table every minute,
// dispatches due verbs, sd_notify's the watchdog every 60s, writes a
// heartbeat file every iteration.
//
// Environment:
//   HABIT_LEDGER_DB             ledger path
//   PROJECT_ROOT              repo root (for bin/dispatch resolution)
//   NOTIFY_SOCKET             systemd Type=notify watchdog socket (set by systemd)
//   HABIT_HEARTBEAT_FILE        heartbeat-file path (default $HABIT_STATE_DIR/habit-daemon.heartbeat)
//   HABIT_TICK_INTERVAL_SEC     polling interval (default 30; min 10)
//   HABIT_WAL_CHECKPOINT_SEC    interval between WAL checkpoint pragma (default 600)
//
// References:
//   - docs/orchestrator/deploy.md (operational guide)

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Ledger } from "./ledger.js";
import { schedulerTick, type DispatchFn } from "./scheduler.js";
import {
  resolveHeartbeatPath as libResolveHeartbeatPath,
  writeHeartbeat as libWriteHeartbeat,
} from "./heartbeat.js";

function info(line: string): void {
  process.stdout.write(`[habit-daemon] ${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`[habit-daemon] ${line}\n`);
}

function resolveDbPath(): string {
  if (process.env.HABIT_LEDGER_DB) return process.env.HABIT_LEDGER_DB;
  const stateDir =
    process.env.HABIT_STATE_DIR ??
    resolve(process.env.PROJECT_ROOT ?? process.cwd(), ".claude/state");
  return resolve(stateDir, "orchestrator-ledger.db");
}

function resolveHeartbeatPath(): string {
  return libResolveHeartbeatPath();
}

// systemd Type=notify watchdog. node:dgram doesn't expose unix_dgram natively,
// so we shell out to /usr/bin/env systemd-notify (the canonical CLI path).
// On non-systemd hosts (NOTIFY_SOCKET unset) this is a no-op.
function sdNotifyViaCli(message: string): void {
  if (!process.env.NOTIFY_SOCKET) return;
  spawnSync("/usr/bin/env", ["systemd-notify", message], { stdio: "ignore" });
}

function writeHeartbeat(path: string): void {
  libWriteHeartbeat(path);
}

function clampInterval(envValue: string | undefined, defaultSec: number, minSec: number): number {
  const n = envValue !== undefined ? Number(envValue) : NaN;
  if (!Number.isInteger(n) || n < minSec) return defaultSec;
  return n;
}

function defaultDispatchBin(): string {
  return resolve(process.env.PROJECT_ROOT ?? process.cwd(), "bin/dispatch");
}

function parseArgsJson(argsJson: string): readonly string[] {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Phase A dispatch factory. Spawns `bin/dispatch <verb> <args...>` via /usr/bin/env
 * and throws on non-zero exit so schedulerTick can route the failure through
 * its missed_run_policy branch. To be replaced by an in-process verb dispatch
 * map in a later phase.
 */
function makeSubprocessDispatch(dispatchBin: string): DispatchFn {
  return async (verb: string, argsJson: string): Promise<void> => {
    const args = parseArgsJson(argsJson);
    const result = spawnSync("/usr/bin/env", [dispatchBin, verb, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitCode = result.status ?? -1;
    if (exitCode !== 0) {
      const stderrTail = (result.stderr ?? "").slice(0, 500);
      throw new Error(`bin/dispatch ${verb} exited ${String(exitCode)}: ${stderrTail}`);
    }
  };
}

export interface LoopContext {
  readonly ledger: Ledger;
  readonly dispatch: DispatchFn;
  readonly heartbeatPath: string;
  readonly tickIntervalSec: number;
  readonly walCheckpointSec: number;
  readonly shouldStop: () => boolean;
}

/**
 * Build a single-tick daemon loop bound to a closure-encapsulated WAL
 * checkpoint timestamp. Exported for testability per Task 4 spec: tests drive
 * one iteration via `createLoop(ctx)()`. Each call to `createLoop` produces
 * an independent loop with its own WAL checkpoint clock, so multiple loops
 * can coexist in one process without sharing module-level mutable state.
 *
 * The returned function schedules the next tick via setTimeout, so invoking
 * it once starts a self-recurring loop.
 */
export function createLoop(ctx: LoopContext): () => Promise<void> {
  let lastWalCheckpointMs = Date.now();

  async function loop(): Promise<void> {
    if (ctx.shouldStop()) {
      ctx.ledger.close();
      info("clean shutdown complete");
      process.exit(0);
    }
    try {
      await schedulerTick({
        db: ctx.ledger.sessionStore.db,
        dispatch: ctx.dispatch,
        onTick: () => {
          writeHeartbeat(ctx.heartbeatPath);
          sdNotifyViaCli("WATCHDOG=1");
        },
      });
      const nowMs = Date.now();
      if (nowMs - lastWalCheckpointMs >= ctx.walCheckpointSec * 1000) {
        ctx.ledger.sessionStore.walCheckpoint();
        lastWalCheckpointMs = nowMs;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      err(`tick exception: ${msg}`);
    }
    setTimeout(() => {
      // setTimeout callback can't be async directly; wrap with a .catch so a
      // rejected promise inside loop() doesn't become an unhandledRejection.
      loop().catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        err(`loop iteration exception: ${msg}`);
      });
    }, ctx.tickIntervalSec * 1000);
  }

  return loop;
}

function main(): void {
  const tickIntervalSec = clampInterval(process.env.HABIT_TICK_INTERVAL_SEC, 30, 10);
  const walCheckpointSec = clampInterval(process.env.HABIT_WAL_CHECKPOINT_SEC, 600, 60);

  const dbPath = resolveDbPath();
  const heartbeatPath = resolveHeartbeatPath();
  const dispatchBin = defaultDispatchBin();

  info(`starting (tick=${String(tickIntervalSec)}s, wal-checkpoint=${String(walCheckpointSec)}s)`);
  info(`ledger:    ${dbPath}`);
  info(`heartbeat: ${heartbeatPath}`);
  info(`bin/dispatch:   ${dispatchBin}`);

  const ledger = new Ledger({ dbPath });
  const dispatch = makeSubprocessDispatch(dispatchBin);

  // sd_notify READY=1 (systemd Type=notify required signal)
  sdNotifyViaCli("READY=1");

  let stop = false;
  const onSignal = (sig: string): void => {
    info(`received ${sig}, shutting down`);
    sdNotifyViaCli("STOPPING=1");
    stop = true;
  };
  process.on("SIGTERM", () => {
    onSignal("SIGTERM");
  });
  process.on("SIGINT", () => {
    onSignal("SIGINT");
  });

  const loop = createLoop({
    ledger,
    dispatch,
    heartbeatPath,
    tickIntervalSec,
    walCheckpointSec,
    shouldStop: () => stop,
  });
  loop().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    err(`initial loop iteration exception: ${msg}`);
  });
}

// Run main() only when this file is the entry point. ESM equivalent of
// require.main === module. Importing this module from a test (Task 4 smoke +
// future tests) must not auto-start the daemon.
//
// The primary check compares import.meta.url against process.argv[1]; the
// .endsWith("scheduler-daemon.js") fallback is defensive against macOS
// launchd / systemd symlink-path differences where the resolved absolute
// path may not byte-for-byte match the file:// URL form. The .ts fallback
// was dropped: production never runs TS source directly post-build, and the
// in-process test (tests/daemon/scheduler-smoke.test.ts) imports rather
// than execs this file.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1] ?? ""}` ||
  process.argv[1]?.endsWith("scheduler-daemon.js") === true;

if (invokedDirectly) {
  main();
}
