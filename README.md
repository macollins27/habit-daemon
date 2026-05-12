# habit-daemon

A long-running daemon that fires per-habit Discord prompts on a cron schedule, escalates them when ignored, verifies completion against real sensor data (Concept2 ergometer, Garmin Connect, Claude vision), and runs a weekly review loop.

Built for a single user, single timezone, single deployment host.

## What it does

- **Schedules habits** — each habit has a cron expression. The scheduler ticks every 30s and dispatches when the next-due time arrives.
- **Escalates when ignored** — L1 prompt → L2 nudge → L3 stakes invocation, with the cadence set per habit.
- **Verifies completion against real data** — rowing sessions come from Concept2 Logbook OAuth, sleep windows from Garmin Connect, photo proof from Claude vision.
- **Runs a Sunday review** — surfaces the week's misses, classifies why, proposes plan adjustments via Discord reactions.

## Requirements

- Node.js 20+
- Python 3.11+ (for the Garmin sensor adapter)
- SQLite (bundled via `better-sqlite3`)
- A private Discord server with five channels: `#morning-row`, `#strength`, `#wind-down`, `#wins`, `#sunday-review`
- Discord bot token (from <https://discord.com/developers/applications>)
- Concept2 Logbook OAuth client (from <https://log.concept2.com/developers/keys>) — optional, only needed for rowing habits
- Garmin Connect account — optional, only needed for sleep-window habits
- Anthropic API key (from <https://console.anthropic.com/settings/keys>)

## Install

```sh
pnpm install
pnpm gate     # typecheck + build + tests
```

## Configure

Create `~/.habit-daemon/` (mode 0700) and two credential files inside it.

**`~/.habit-daemon/env`** (mode 0600):

```
ANTHROPIC_API_KEY=sk-ant-...
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_MORNING_ROW=...
DISCORD_CHANNEL_STRENGTH=...
DISCORD_CHANNEL_WIND_DOWN=...
DISCORD_CHANNEL_WINS=...
DISCORD_CHANNEL_SUNDAY_REVIEW=...
```

**`~/.habit-daemon/concept2-credentials.json`** (mode 0600):

```json
{
  "client_id": "...",
  "client_secret": "...",
  "redirect_uri": "http://localhost:8765/concept2/callback"
}
```

Garmin auth tokens are seeded interactively (one-time) on first run of the Garmin fetch script.

## Run

```sh
pnpm build
node dist/daemon/scheduler-daemon.js
```

For production deployment, run under launchd (macOS) or systemd (Linux) with the env file loaded into the service environment.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the data model, scheduler loop, proof verification pipeline, and sensor adapter contracts.

## License

[MIT](./LICENSE)
