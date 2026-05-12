# ADR 0002: Deployment target is macOS with launchd, not Linux with systemd

**Status:** Accepted
**Date:** 2026-05-12

## Context

habit-daemon runs on a single host: the same Mac that the developer
uses day-to-day. There is no separate server, no container, no remote
deploy target. The runtime supervisor must:

- Start the daemon at user login.
- Restart it if it crashes, with a throttle to avoid restart storms.
- Load runtime secrets from `~/.habit-daemon/env`.
- Redirect stdout/stderr to log files under `~/.habit-daemon/logs/`.
- Cooperate with the daemon's own watchdog discipline (heartbeat file
  + cron-driven staleness check) since macOS has no native
  systemd-style `WatchdogSec`.

macOS uses launchd, not systemd. Borrowing a systemd unit file would
require either running a Linux VM (extra infrastructure) or porting
the unit semantics to launchd at deploy time.

## Decision

Production deployment uses a launchd `LaunchAgent` plist at
`~/Library/LaunchAgents/com.habit-daemon.plist`, loaded into the user
session via `launchctl bootstrap gui/$UID …` and unloaded via
`launchctl bootout …`.

The plist maps systemd concepts to launchd as follows:

| systemd                         | launchd equivalent                         |
|---------------------------------|--------------------------------------------|
| `Restart=on-failure`            | `KeepAlive` with `SuccessfulExit=false`    |
| `RestartSec`                    | `ThrottleInterval`                         |
| `EnvironmentFile=…`             | `EnvironmentVariables` block (or file load)|
| `StandardOutput=`/`StandardError=` | `StandardOutPath` / `StandardErrorPath` |
| `Type=notify` + `WatchdogSec`   | application-layer heartbeat (see below)    |

Because launchd has no native watchdog, the daemon writes a heartbeat
file on each scheduler tick (layer 2) and a separate cron-driven
staleness check (layer 3) reads that heartbeat's mtime and alerts if
it falls too far behind. The two layers together carry the watchdog
discipline that `Type=notify` + `WatchdogSec` would have provided on
systemd.

## Consequences

- No additional infrastructure required on the developer's Mac.
  launchd ships with the OS, is well-documented, and is debuggable via
  `launchctl print …`, `launchctl error …`, and the system log.
- Bootstrap scripts (`install.sh`, `uninstall.sh`) live in `deploy/`
  and wrap the `launchctl bootstrap` / `bootout` lifecycle so the
  human-facing install procedure stays one command.
- Adding a Linux deployment target later requires a parallel
  `deploy/habit-daemon.service` unit and a new ADR documenting the
  systemd mapping. Until then, Linux deployment is undefined.
- The heartbeat/staleness check is now load-bearing for liveness
  monitoring; bugs in those code paths will not surface as
  supervisor-level restarts and must be tested independently.

## Alternatives considered

- **systemd on Linux.** Rejected for now: no Linux host is in scope
  and adding one means provisioning, securing, and maintaining a
  separate machine that exists only to run this daemon.
- **Cross-platform supervisor (supervisord, pm2, etc.).** Adds a
  runtime dependency and a config-file dialect to learn. Neither tool
  provides anything launchd doesn't already provide on macOS.
- **Containerize and run under Docker Desktop.** Heavy for a single
  long-running Node process on the developer's own machine; adds
  Docker as a hard runtime dependency for what is fundamentally a
  user-session daemon.
