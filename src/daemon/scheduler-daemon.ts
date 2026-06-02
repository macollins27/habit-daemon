// Long-running scheduler entry point. Run via launchd (macOS — see
// deploy/com.habit-daemon.plist) or systemd on Linux. Polls the schedules
// table every tick, dispatches due verbs via the in-process verb map from
// bootstrap.ts, sd_notify's the watchdog every iteration, writes a
// heartbeat file every iteration.
//
// Environment (loaded by bootstrap.ts from ~/.habit-daemon/env unless
// already set by launchd's EnvironmentVariables block):
//   HABIT_LEDGER_DB             ledger path (default ~/.habit-daemon/state.db)
//   HABIT_STATE_DIR             state dir override
//   HABIT_HEARTBEAT_FILE        heartbeat-file path
//   HABIT_TICK_INTERVAL_SEC     polling interval (default 30; min 10)
//   HABIT_WAL_CHECKPOINT_SEC    interval between WAL checkpoint pragma (default 600)
//   ANTHROPIC_API_KEY           Claude CLI auth (with --bare flag)
//   DISCORD_BOT_TOKEN           Discord bot auth
//   DISCORD_CHANNEL_*           channel id env vars
//   NOTIFY_SOCKET               systemd Type=notify watchdog socket (set by systemd; unset on launchd)

import { spawnSync } from "node:child_process";
import { Ledger } from "./ledger.js";
import { schedulerTick, type DispatchFn } from "./scheduler.js";
import { bootstrap } from "./bootstrap.js";
import {
  resolveHeartbeatPath as libResolveHeartbeatPath,
  writeHeartbeat as libWriteHeartbeat,
} from "./heartbeat.js";
import { startServer, type ServerHandle } from "../api/server.js";
import { tokensPath as concept2TokensPath } from "../lib/concept2-adapter.js";

function info(line: string): void {
  process.stdout.write(`[habit-daemon] ${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`[habit-daemon] ${line}\n`);
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

/**
 * Parse the HTTP API port from `HABIT_API_PORT`. Defaults to 8787 (the
 * port the SPA dev proxy and chat client both expect). Returns the
 * default rather than throwing when the env var is set but unparseable —
 * the daemon should still boot, with the port logged so the operator
 * can correct the misconfiguration.
 */
function resolveApiPort(): number {
  const raw = process.env.HABIT_API_PORT;
  if (raw === undefined || raw === "") return 8787;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 65535) {
    return 8787;
  }
  return n;
}

/**
 * Build the concept2 tokens path for /api/health to read. The daemon
 * source-of-truth lives in `src/lib/concept2-adapter.ts::tokensPath()`,
 * which honours `$HOME/.habit-daemon/concept2-tokens.json`. We delegate
 * rather than reimplementing the path math so a future state-dir move
 * touches one file.
 */
function resolveConcept2TokensPath(): string {
  return concept2TokensPath();
}

async function main(): Promise<void> {
  const tickIntervalSec = clampInterval(process.env.HABIT_TICK_INTERVAL_SEC, 30, 10);
  const walCheckpointSec = clampInterval(process.env.HABIT_WAL_CHECKPOINT_SEC, 600, 60);
  const heartbeatPath = resolveHeartbeatPath();

  info(`starting (tick=${String(tickIntervalSec)}s, wal-checkpoint=${String(walCheckpointSec)}s)`);
  info(`heartbeat: ${heartbeatPath}`);

  // Bootstrap loads env, opens the ledger, runs migrations, seeds habits,
  // registers cron rows, logs in the Discord client, and returns the
  // in-process verb dispatch function. See src/daemon/bootstrap.ts.
  const { ledger, dispatch, sessionId, cleanup, adapter } = await bootstrap();
  info(`bootstrap complete (session=${sessionId})`);

  // Start the HTTP API alongside the scheduler loop. The API reads
  // ledger state, the heartbeat-file mtime, the persisted Concept2
  // tokens file, and the live discord adapter's websocket status —
  // every dep is wired explicitly here so the API has no implicit
  // module-level singletons.
  //
  // 127.0.0.1 only (enforced inside startServer); never reachable
  // off-loopback. The port is configurable via HABIT_API_PORT, but
  // 8787 matches the SPA dev proxy + chat client default.
  const apiPort = resolveApiPort();
  const apiServer: ServerHandle = await startServer(
    {
      sessionStore: ledger.sessionStore,
      heartbeatPath,
      discordConnected: (): boolean => adapter.isReady(),
      concept2TokensPath: resolveConcept2TokensPath(),
    },
    apiPort,
  );
  info(`HTTP API listening on 127.0.0.1:${String(apiServer.port)}`);

  // sd_notify READY=1 (systemd Type=notify required signal; no-op on launchd)
  sdNotifyViaCli("READY=1");

  // `shuttingDown` guards against a double-fired signal (SIGTERM followed by
  // a second SIGTERM or SIGINT during the same shutdown window). The second
  // invocation must not double-close the API server or re-invoke `cleanup`
  // — discord.js's `destroy()` and the better-sqlite3 close are both
  // idempotent in principle, but the API listener's underlying Node Server
  // throws on a second `close()` call.
  let stop = false;
  let shuttingDown = false;
  const onSignal = (sig: string): void => {
    if (shuttingDown) {
      info(`received ${sig} during shutdown; ignoring`);
      return;
    }
    shuttingDown = true;
    info(`received ${sig}, shutting down`);
    sdNotifyViaCli("STOPPING=1");
    stop = true;

    // Close the HTTP listener first so no in-flight request can observe
    // the ledger after we've started tearing it down. Wrapped in try/catch
    // because the downstream cleanups (discord, ledger) MUST run even if
    // the API close throws.
    try {
      apiServer.close();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      err(`api server close exception during ${sig}: ${msg}`);
    }

    cleanup().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      err(`cleanup exception during ${sig}: ${msg}`);
    });
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
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    err(`fatal: ${msg}`);
    process.exit(1);
  });
}
