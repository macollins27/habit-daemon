#!/usr/bin/env bash
# habit-daemon install script (macOS / launchd, dev-mode install).
#
# Builds the project in-place and installs the LaunchAgent plist that points
# at this repo's `dist/`. No sudo, no /opt copy — appropriate for the
# single-user single-host deployment per ADR 0002.
#
# Per ADR 0002. Requires: pnpm, ~/.habit-daemon/ already provisioned
# (env file + credentials per pre-Phase-A logistics).
#
# Paths are hardcoded to the founder's host (/Users/maxwellcollins/...).
# The plist's ProgramArguments + StandardOut/Err paths must match this
# host. Update deploy/com.habit-daemon.plist if porting to another machine.

set -euo pipefail

PLIST_NAME="com.habit-daemon"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST_SOURCE="deploy/$PLIST_NAME.plist"
PLIST_TARGET="$LAUNCH_AGENT_DIR/$PLIST_NAME.plist"

cd "$(dirname "$0")/.."  # Move to repo root from deploy/

# 1. Sanity checks
test -d "$HOME/.habit-daemon" || { echo "ERROR: ~/.habit-daemon/ not provisioned. See pre-Phase-A logistics."; exit 1; }
test -f "$HOME/.habit-daemon/env" || { echo "ERROR: ~/.habit-daemon/env missing."; exit 1; }
mkdir -p "$HOME/.habit-daemon/logs"

# 2. Build (in-place; daemon runs from this repo's dist/)
echo "Building..."
pnpm install --frozen-lockfile
pnpm build

# 3. Copy SQL migrations into dist/db/migrations (tsc doesn't copy non-.ts assets)
echo "Copying SQL migrations into dist/..."
mkdir -p dist/db/migrations
cp src/db/migrations/*.sql dist/db/migrations/

# 4. Install plist
mkdir -p "$LAUNCH_AGENT_DIR"
cp "$PLIST_SOURCE" "$PLIST_TARGET"

# 5. Load via launchctl
echo "Loading LaunchAgent..."
launchctl bootout "gui/$(id -u)" "$PLIST_TARGET" 2>/dev/null || true  # unload if previously loaded
launchctl bootstrap "gui/$(id -u)" "$PLIST_TARGET"
launchctl kickstart -k "gui/$(id -u)/$PLIST_NAME"

# 6. Verify
sleep 3
if launchctl print "gui/$(id -u)/$PLIST_NAME" >/dev/null 2>&1; then
  echo ""
  echo "habit-daemon installed and running"
  echo ""
  echo "  Status: launchctl print gui/\$(id -u)/$PLIST_NAME"
  echo "  Logs:   tail -f $HOME/.habit-daemon/logs/stderr.log"
  echo "  Stop:   launchctl bootout gui/\$(id -u)/$PLIST_TARGET"
  echo ""
else
  echo "ERROR: daemon failed to start. Check logs at $HOME/.habit-daemon/logs/"
  exit 1
fi
