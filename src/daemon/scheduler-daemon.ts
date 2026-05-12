/**
 * Forked from Property-Linkware-v2.1/scripts/orchestrate/scheduler-daemon.ts
 * at PLW commit v1 (26c8c049). Diverges from this point. Do not auto-sync.
 *
 * Habit-daemon adaptation (Task 4, 2026-05-12; divergence #2): the
 * `bin/plw` subprocess spawn that used to live inside scheduler.ts now lives
 * here, inside the dispatch factory passed to schedulerTick. The scheduler
 * itself is substrate-agnostic. The `bin/plw` spawn is retained for Phase A
 * bootstrap so the daemon entry-point keeps working end-to-end; it will be
 * replaced by an in-process verb dispatch map at Task 32. PLW_* env vars
 * stay as-is and are renamed to HABIT_* at Task 39 per divergence #2.
 */
// scripts/orchestrate/scheduler-daemon.ts
//
// Long-running scheduler entry point. Run via systemd (canonical) or
// supervisord / pm2 (alternative). Polls the schedules table every minute,
// dispatches due verbs, sd_notify's the watchdog every 60s, writes a
// heartbeat file every iteration.
//
// Environment:
//   PLW_LEDGER_DB             ledger path
//   PROJECT_ROOT              repo root (for bin/plw resolution)
//   NOTIFY_SOCKET             systemd Type=notify watchdog socket (set by systemd)
//   PLW_HEARTBEAT_FILE        heartbeat-file path (default $PLW_STATE_DIR/plw.heartbeat)
//   PLW_TICK_INTERVAL_SEC     polling interval (default 30; min 10)
//   PLW_WAL_CHECKPOINT_SEC    interval between WAL checkpoint pragma (default 600)
//
// References:
//   - docs/plans/master-orchestrator-design-v2.md §15 (v0.3)
//   - docs/orchestrator/deploy.md (operational guide)

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "./ledger.js";
import { schedulerTick, type DispatchFn } from "./scheduler.js";
import {
  resolveHeartbeatPath as libResolveHeartbeatPath,
  writeHeartbeat as libWriteHeartbeat,
} from "./heartbeat.js";

function info(line: string): void {
  process.stdout.write(`[plw-daemon] ${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`[plw-daemon] ${line}\n`);
}

function resolveDbPath(): string {
  if (process.env.PLW_LEDGER_DB) return process.env.PLW_LEDGER_DB;
  const stateDir =
    process.env.PLW_STATE_DIR ??
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

function defaultPlwBin(): string {
  return resolve(process.env.PROJECT_ROOT ?? process.cwd(), "bin/plw");
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
 * Phase A dispatch factory. Spawns `bin/plw <verb> <args...>` via /usr/bin/env
 * and throws on non-zero exit so schedulerTick can route the failure through
 * its missed_run_policy branch. To be replaced at Task 32 by an in-process
 * verb dispatch map (divergence #2 — PLW fork adaptation at point of
 * activation).
 */
function makeBinPlwDispatch(plwBin: string): DispatchFn {
  return async (verb: string, argsJson: string): Promise<void> => {
    const args = parseArgsJson(argsJson);
    const result = spawnSync("/usr/bin/env", [plwBin, verb, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitCode = result.status ?? -1;
    if (exitCode !== 0) {
      const stderrTail = (result.stderr ?? "").slice(0, 500);
      throw new Error(`bin/plw ${verb} exited ${String(exitCode)}: ${stderrTail}`);
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
 * Single tick of the daemon loop. Exposed (via `loop`) for testability per
 * Task 4 spec. Schedules the next tick via setTimeout, so calling once
 * starts a self-recurring loop.
 */
export function loop(ctx: LoopContext): void {
  const runIteration = async (): Promise<void> => {
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
      loop(ctx);
    }, ctx.tickIntervalSec * 1000);
  };

  // setTimeout callback can't be async directly; wrap with a .catch so a
  // rejected promise inside runIteration doesn't become an unhandledRejection.
  runIteration().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    err(`loop iteration exception: ${msg}`);
    setTimeout(() => {
      loop(ctx);
    }, ctx.tickIntervalSec * 1000);
  });
}

// Module-level WAL checkpoint timestamp shared across loop iterations.
let lastWalCheckpointMs = Date.now();

function main(): void {
  const tickIntervalSec = clampInterval(process.env.PLW_TICK_INTERVAL_SEC, 30, 10);
  const walCheckpointSec = clampInterval(process.env.PLW_WAL_CHECKPOINT_SEC, 600, 60);

  const dbPath = resolveDbPath();
  const heartbeatPath = resolveHeartbeatPath();
  const plwBin = defaultPlwBin();

  info(`starting (tick=${String(tickIntervalSec)}s, wal-checkpoint=${String(walCheckpointSec)}s)`);
  info(`ledger:    ${dbPath}`);
  info(`heartbeat: ${heartbeatPath}`);
  info(`bin/plw:   ${plwBin}`);

  const ledger = new Ledger({ dbPath });
  const dispatch = makeBinPlwDispatch(plwBin);

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

  lastWalCheckpointMs = Date.now();

  loop({
    ledger,
    dispatch,
    heartbeatPath,
    tickIntervalSec,
    walCheckpointSec,
    shouldStop: () => stop,
  });
}

// Run only when invoked as a script. ESM equivalent of require.main === module.
// Importing this module from a test (Task 4 smoke + future tests) must not
// auto-start the daemon.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1] ?? ""}` ||
  (process.argv[1] !== undefined &&
    (process.argv[1].endsWith("scheduler-daemon.js") ||
      process.argv[1].endsWith("scheduler-daemon.ts")));

if (invokedDirectly) {
  main();
}
