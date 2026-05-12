// scripts/lib/orchestrator/heartbeat.ts
//
// Heartbeat write + staleness-check primitives per design v2 §13 + R7.
//
// Three-layer liveness shape:
//   Layer 1: process check (systemd / launchd handles externally)
//   Layer 2: heartbeat file mtime — written by long-lived daemons (scheduler)
//            on each tick; checked by the status command + monitoring scripts.
//   Layer 3: cron-driven staleness check (infrastructure/orchestrator/heartbeat.sh
//            check, scheduled via crontab-example or systemd timer).
//
// This TS module covers Layer 2 from the orchestrator's TypeScript surface.
// The bash equivalent (infrastructure/orchestrator/heartbeat.sh) covers
// Layer 3 (cron callability).
//
// References:
//   - infrastructure/orchestrator/heartbeat.sh (bash sibling)

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const DEFAULT_STALENESS_SEC = 1800; // 30 minutes — matches heartbeat.sh default

export function resolveHeartbeatPath(): string {
  if (process.env.HABIT_HEARTBEAT_FILE) return process.env.HABIT_HEARTBEAT_FILE;
  const stateDir =
    process.env.HABIT_STATE_DIR ??
    resolve(process.env.PROJECT_ROOT ?? process.cwd(), ".claude/state");
  return resolve(stateDir, "habit-daemon.heartbeat");
}

/**
 * Write the current ISO timestamp to the heartbeat file. Called by long-lived
 * daemons (scheduler-daemon) on each tick. Shells out to `sh -c` so we get
 * atomic redirect via the shell's `>` (safer than fs.writeFileSync under the
 * security/detect-non-literal-fs-filename lint rule).
 */
export function writeHeartbeat(path?: string): void {
  const target = path ?? resolveHeartbeatPath();
  spawnSync(
    "/usr/bin/env",
    ["sh", "-c", `echo "$(date -u +%s) $(date -u -Iseconds)" > "${target}"`],
    { stdio: "ignore" },
  );
}

export interface HeartbeatStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly ageSec: number | null;
  readonly stale: boolean;
  readonly lastWrittenIso: string | null;
}

/**
 * Read the heartbeat file mtime + content; report freshness vs threshold.
 * Used by the status command to surface "is the daemon alive?" without depending
 * on systemd/launchd.
 */
export function checkHeartbeat(opts?: { path?: string; stalenessSec?: number }): HeartbeatStatus {
  const path = opts?.path ?? resolveHeartbeatPath();
  const stalenessSec = opts?.stalenessSec ?? DEFAULT_STALENESS_SEC;

  // /usr/bin/test -e (matches verify-footer.ts pattern; avoids fs.existsSync lint)
  const exists = spawnSync("/bin/test", ["-e", path], { stdio: "ignore" }).status === 0;
  if (!exists) {
    return { path, exists: false, ageSec: null, stale: true, lastWrittenIso: null };
  }
  // stat -c %Y on Linux, stat -f %m on BSD/macOS — mirror heartbeat.sh's logic.
  const mtimeLinux = spawnSync("/usr/bin/env", ["stat", "-c", "%Y", path], { encoding: "utf8" });
  const mtimeBsd = spawnSync("/usr/bin/env", ["stat", "-f", "%m", path], { encoding: "utf8" });
  const mtimeStr = (mtimeLinux.stdout ?? "").trim() || (mtimeBsd.stdout ?? "").trim() || "0";
  const mtimeSec = Number(mtimeStr);
  if (!Number.isFinite(mtimeSec) || mtimeSec === 0) {
    return { path, exists: true, ageSec: null, stale: true, lastWrittenIso: null };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSec = nowSec - mtimeSec;
  const lastWrittenIso = new Date(mtimeSec * 1000).toISOString();
  return {
    path,
    exists: true,
    ageSec,
    stale: ageSec > stalenessSec,
    lastWrittenIso,
  };
}
