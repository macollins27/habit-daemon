# Phase A divergence log

Running notes on known divergences from the design and Phase A implementation plan as committed. Captured pre-Task-1 from the founder ↔ Claude logistics handoff. Folded into `docs/retros/phase-A-retro.md` at Phase A close (Task 42).

New divergences are appended in numerical order below.

---

## 1. PLW fork file count undercounted by 1 — `footer-schema.ts` is the 11th file

**Source:** `docs/plans/2026-05-12-phase-a-implementation.md` Task 3.

The plan names 10 files to fork from PLW v1. The actual count is 11: `verify-footer.ts` imports `./footer-schema` for `PlwFooterSchema`, `validateFooterCrossFields`, and the `PlwFooter` type. Without forking `footer-schema.ts`, Task 3 cannot typecheck.

**Resolution:** Task 3 brief includes `footer-schema.ts` in the fork with the same provenance header. The Task 3 commit body notes the addition. No spec change beyond this divergence note.

---

## 2. PLW fork is a structural copy, not drop-in — adaptation is per-task, not upfront

**Source:** `docs/plans/2026-05-12-phase-a-implementation.md` Task 3 + the user's logistics handoff decision on Issue 2.

`sdk-dispatch.ts` and other forked files reference PLW-specific runtime artifacts: `scripts/sandbox/run-dispatch.sh`, `process.env.PROJECT_ROOT`, `PLW_DRY_RUN`, `PLW_USE_SANDBOX`, the `bin/plw` binary path, etc. Task 3 copies these files verbatim with the provenance header but does NOT adapt the references. Adaptation happens at the task that first activates each forked file (rename `PLW_*` env vars to `HABIT_*`, strip the sandbox path, replace `bin/plw` subprocess spawn with in-process verb dispatch, etc.).

**Resolution / discipline rule:** When a task touches a forked file for the first time, that task's commit handles the necessary adaptation in the same commit. No "Task 3-bis" or other phase-within-phase smuggling. Phase A retro acknowledges that the PLW fork is structural-not-drop-in.

---

## 3. cron-parser switched from UTC to local time

**Source:** Founder logistics handoff decision on Issue 3.

PLW's `cron-parser.ts` matches against UTC (`getUTCMinutes`, `getUTCHours`, `getUTCDate`, `getUTCMonth`, `getUTCDay`) and the fallback `parseViaCronParserPackage` uses `tz: "UTC"`. The habit-daemon's design crons (`5 9 * * *`, `0 22 * * 0-4`, `20 18 * * 1,3,5`) are expressed in **local** time. Deployment is single-user, single-host (America/New_York, confirmed via `readlink /etc/localtime`). Matching against UTC would silently misfire every habit.

**Resolution:** In the task that forks `cron-parser.ts` (Tier 2, Task 3), replace every `getUTC*` call with the local-time equivalent (`getMinutes`, `getHours`, `getDate`, `getMonth`, `getDay`) and remove `tz: "UTC"` from the `cron-parser` package fallback. The fix lands in the same commit as the fork. The fork file's provenance header documents this divergence from PLW.

Options (a) — add a `timezone` column on `habits` — and (b) — translate crons to UTC at seed time — are over-engineering for a single-user, single-timezone deployment. Revisit only if the system ever needs multi-host or multi-user support.

---

## 4. Deployment is macOS + launchd, not Linux + systemd

**Source:** Founder logistics handoff decision on Investigation #1.

`docs/plans/2026-05-12-phase-a-implementation.md` Task 39 specifies a systemd unit file (`deploy/habit-daemon.service` with `Type=notify`, `WatchdogSec=120`, `WantedBy=multi-user.target`, `ExecStart=/usr/bin/node ...`). The actual deployment target is macOS — the founder's dev Mac doubles as the runtime host. macOS uses launchd, not systemd.

**Resolution:** Task 39 deliverable becomes `~/Library/LaunchAgents/com.habit-daemon.plist` (plus an `install.sh` that does `launchctl bootstrap gui/$UID …` / `launchctl bootout …`-style lifecycle). Service shape:
- `KeepAlive` (with sub-keys `SuccessfulExit=false` and optional `NetworkState=true`) replaces `Restart=on-failure`.
- `ThrottleInterval` replaces `RestartSec`.
- `EnvironmentVariables` block (or `EnvironmentVariablesFromFile` pattern) loads `~/.habit-daemon/env`.
- launchd has no native watchdog. The Layer 2 heartbeat-file write + Layer 3 cron-driven staleness check (already present in PLW's `heartbeat.ts` / `heartbeat.sh`) carry the watchdog discipline.
- `StandardOutPath` / `StandardErrorPath` point at `~/.habit-daemon/logs/`.

PLW's `heartbeat.ts` already has macOS code paths (`stat -f %m` fallback). Confirm those carry over correctly at Task 39 time.

---

## 5. Python lives in `~/.habit-daemon/venv` per PEP 668

**Source:** Founder logistics handoff.

`docs/plans/2026-05-12-phase-a-implementation.md` pre-Phase-A logistics §3 says `pip install garminconnect`. Homebrew Python 3.12 (which the founder uses on macOS — system Python 3.9.6 is too old) enforces PEP 668 and refuses both `pip install garminconnect` and `pip install --user garminconnect` outside a venv. `garminconnect==0.3.3` was installed into a venv at `~/.habit-daemon/venv/`.

**Resolution:**
- Task 12 (`scripts/garmin_fetch.py`): script either uses a shebang pinning the venv interpreter (`#!/Users/maxwellcollins/.habit-daemon/venv/bin/python` is host-specific; consider `#!/usr/bin/env -S /Users/maxwellcollins/.habit-daemon/venv/bin/python` or a small wrapper that activates the venv) OR documents that callers must invoke `~/.habit-daemon/venv/bin/python scripts/garmin_fetch.py`.
- Task 13 (`src/lib/garmin-adapter.ts`): the Node bridge invokes the venv interpreter explicitly via `spawnSync(<resolved venv python path>, ['scripts/garmin_fetch.py', ...])`. Resolve `~/.habit-daemon/venv/bin/python` at call time (read `os.homedir()` + `/.habit-daemon/venv/bin/python`); do not bare-call `python3` or `python`.

The venv path is part of the host's `~/.habit-daemon/` credential surface, not the repo. Repo never assumes a system-wide `garminconnect` install.

---

End of divergence log. Append new divergences above this line, in numerical order.
