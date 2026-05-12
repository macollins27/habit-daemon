/**
 * Forked from Property-Linkware-v2.1/scripts/orchestrate/scheduler-daemon.ts
 * at PLW commit v1 (26c8c049). Diverges from this point. Do not auto-sync.
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
import { Ledger } from "./ledger.js";
import { defaultPlwBin, schedulerTick } from "./scheduler.js";
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

  let lastWalCheckpointMs = Date.now();

  const loop = (): void => {
    if (stop) {
      ledger.close();
      info("clean shutdown complete");
      process.exit(0);
    }
    try {
      schedulerTick({
        ledger,
        plwBin,
        onTick: () => {
          writeHeartbeat(heartbeatPath);
          sdNotifyViaCli("WATCHDOG=1");
        },
      });
      const nowMs = Date.now();
      if (nowMs - lastWalCheckpointMs >= walCheckpointSec * 1000) {
        ledger.sessionStore.walCheckpoint();
        lastWalCheckpointMs = nowMs;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      err(`tick exception: ${msg}`);
    }
    setTimeout(loop, tickIntervalSec * 1000);
  };

  loop();
}

main();
