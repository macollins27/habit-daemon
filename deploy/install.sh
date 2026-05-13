#!/usr/bin/env bash
# habit-daemon install script (macOS / launchd).
# Builds the project, copies artifacts to /opt/habit-daemon, installs
# the LaunchAgent plist, and bootstraps the daemon via launchctl.
#
# Per ADR 0002. Requires: pnpm, sudo, ~/.habit-daemon/ already provisioned
# (env file + credentials per pre-Phase-A logistics).
#
# Paths are hardcoded to the founder's host (/Users/maxwellcollins/...).
# If this is ever ported to another machine, update the StandardOut/Err
# paths inside deploy/com.habit-daemon.plist accordingly.

set -euo pipefail

INSTALL_ROOT="/opt/habit-daemon"
PLIST_NAME="com.habit-daemon"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST_SOURCE="deploy/$PLIST_NAME.plist"
PLIST_TARGET="$LAUNCH_AGENT_DIR/$PLIST_NAME.plist"

cd "$(dirname "$0")/.."  # Move to repo root from deploy/

# 1. Sanity checks
test -d "$HOME/.habit-daemon" || { echo "ERROR: ~/.habit-daemon/ not provisioned. See pre-Phase-A logistics."; exit 1; }
test -f "$HOME/.habit-daemon/env" || { echo "ERROR: ~/.habit-daemon/env missing."; exit 1; }
mkdir -p "$HOME/.habit-daemon/logs"

# 2. Build
echo "Building..."
pnpm install --frozen-lockfile
pnpm build

# 3. Copy artifacts to /opt/habit-daemon
echo "Installing to $INSTALL_ROOT..."
sudo mkdir -p "$INSTALL_ROOT"
sudo rm -rf "$INSTALL_ROOT/dist" "$INSTALL_ROOT/scripts" "$INSTALL_ROOT/node_modules"
sudo cp -r dist "$INSTALL_ROOT/"
# SQL migrations need to be alongside compiled JS (tsc doesn't copy them)
sudo mkdir -p "$INSTALL_ROOT/dist/db/migrations"
sudo cp src/db/migrations/*.sql "$INSTALL_ROOT/dist/db/migrations/"
sudo cp -r scripts "$INSTALL_ROOT/"
sudo cp -r node_modules "$INSTALL_ROOT/"
sudo cp package.json "$INSTALL_ROOT/"
sudo chown -R "$(whoami):staff" "$INSTALL_ROOT"

# 4. Install plist
mkdir -p "$LAUNCH_AGENT_DIR"
cp "$PLIST_SOURCE" "$PLIST_TARGET"

# 5. Load via launchctl
echo "Loading LaunchAgent..."
launchctl bootout "gui/$(id -u)" "$PLIST_TARGET" 2>/dev/null || true  # unload if previously loaded
launchctl bootstrap "gui/$(id -u)" "$PLIST_TARGET"
launchctl kickstart -k "gui/$(id -u)/$PLIST_NAME"

# 6. Verify
sleep 2
if launchctl print "gui/$(id -u)/$PLIST_NAME" >/dev/null 2>&1; then
  echo "habit-daemon installed and running"
  echo "Logs: tail -f $HOME/.habit-daemon/logs/stderr.log"
else
  echo "ERROR: daemon failed to start. Check logs at $HOME/.habit-daemon/logs/"
  exit 1
fi
