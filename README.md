<div align="center">

# habit-daemon

**The Discord bot that doesn't let you negotiate with yourself.**

A long-running daemon that fires habit prompts on a cron schedule, escalates when you ignore them, and verifies completion against real sensor data — your rower, your sleep tracker, your camera.

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![SQLite WAL](https://img.shields.io/badge/sqlite-WAL-003B57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org)
[![Anthropic SDK](https://img.shields.io/badge/anthropic-claude--agent--sdk-D97757)](https://docs.anthropic.com)

</div>

---

## What it actually does

You commit to three habits. Each one has a cron expression, an escalation cadence, and a way to *prove* you did it.

| Habit | What it is | How it gets verified |
|---|---|---|
| `row` | Concept2 ergometer session | Pulled from Concept2 Logbook API — distance, duration, type checked against your window |
| `strength` | gym or home workout | Photo upload in Discord → Claude vision evaluates against a habit-specific prompt |
| `wind-down` | in bed before 11pm | Garmin Connect sleep window — the daemon reads when you actually fell asleep |

If you ignore the L1 prompt, it L2-escalates. Ignore L2, it L3-escalates and invokes the financial or relational stake you pre-committed.

No "soft reminders." No "maybe later." The mechanism is the point.

Sunday night the daemon does a review: classifies every miss, looks for patterns ("you skipped row four out of five times when work ran past 8pm"), and proposes plan adjustments. You accept or reject via Discord reaction.

---

## A typical morning

```
09:05  #morning-row    L1   "Row's queued. 5km steady state, Z2. 30 min."
                       │
                       └── ignored

09:35  #morning-row    L2   "Still no row. You picked this window for a reason.
                            Push it now or skip with /skip <reason>."
                       │
                       └── ignored

10:00  #morning-row    L3   "Stake invoked: $50 → opposite-political-party.
                            This is the deal you made on Sunday."
                       │
                       └── you finally row

10:42  #wins                ✓ row · 5,127m · 30:14 · 2:56/500m
```

---

## Architecture in 30 seconds

```
┌────────────────────────────────────────────────────┐
│  scheduler-daemon  (long-running Node process)     │
│                                                    │
│   ├─ ticks every 30s                               │
│   ├─ reads schedules from SQLite (WAL)             │
│   ├─ dispatches verbs via Anthropic SDK            │
│   └─ writes heartbeat → watched by launchd/systemd │
└──┬──────────────────────────────────────────────┬──┘
   │                                              │
   ▼                                              ▼
┌──────────────────┐                ┌──────────────────────┐
│  habit-state.db  │                │   Discord (5 ch.)    │
│  ─────────────   │                │   ───────────────    │
│  habits          │                │   #morning-row       │
│  habit_runs      │                │   #strength          │
│  proof_stages    │                │   #wind-down         │
│  miss_reasons    │                │   #wins              │
│  sensor_signals  │                │   #sunday-review     │
│  plan_changes    │                └──────────────────────┘
└──────────────────┘
   ▲
   │ writes verified sessions
   │
┌──┴───────────┐  ┌────────────────┐  ┌─────────────────┐
│  Concept2    │  │  Garmin        │  │  Claude vision  │
│  Logbook API │  │  Connect SSO   │  │  (image proof)  │
└──────────────┘  └────────────────┘  └─────────────────┘
```

Full design in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 20+ |
| Language | TypeScript (strict, ESM) |
| Storage | SQLite via `better-sqlite3`, WAL journal mode |
| Validation | Zod |
| Cron | hand-rolled local-time parser + `cron-parser` fallback |
| LLM | `@anthropic-ai/claude-agent-sdk` |
| Discord | `discord.js` v14 |
| Sensors | Concept2 OAuth · `garminconnect` (Python) · Claude vision |
| Tests | Vitest |
| Deploy | launchd (macOS) · systemd (Linux) |

---

## Install

```sh
pnpm install
pnpm gate          # typecheck + build + run all tests
```

That's it for the codebase. The credential setup is the actual work — see [Configure](#configure).

---

## Configure

You need: a private Discord server with five channels, a Concept2 Logbook OAuth client, a Garmin Connect account, and an Anthropic API key.

Create `~/.habit-daemon/` (mode `0700`) and drop two files in it.

**`~/.habit-daemon/env`** — runtime secrets and channel IDs (`chmod 600`):

```ini
ANTHROPIC_API_KEY=sk-ant-...
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_MORNING_ROW=...
DISCORD_CHANNEL_STRENGTH=...
DISCORD_CHANNEL_WIND_DOWN=...
DISCORD_CHANNEL_WINS=...
DISCORD_CHANNEL_SUNDAY_REVIEW=...
```

**`~/.habit-daemon/concept2-credentials.json`** — Concept2 OAuth client (`chmod 600`):

```json
{
  "client_id": "...",
  "client_secret": "...",
  "redirect_uri": "http://localhost:8765/concept2/callback"
}
```

Garmin auth tokens are seeded interactively on first run of the fetch script. Concept2 OAuth tokens are exchanged and refreshed automatically once the client is registered.

> **Where the credentials come from**
> - Discord bot + channel IDs: <https://discord.com/developers/applications>
> - Concept2 OAuth client: <https://log.concept2.com/developers/keys> (the live env, not log-dev)
> - Anthropic API key: <https://console.anthropic.com/settings/keys>

---

## Run

```sh
pnpm build
node dist/daemon/scheduler-daemon.js
```

The daemon prints its config, opens the SQLite WAL connection, starts the scheduler loop, and sits there waiting for cron edges. For production, drop a `~/Library/LaunchAgents/com.habit-daemon.plist` (macOS) or a `systemd` unit (Linux) that loads `~/.habit-daemon/env` into the service environment.

---

## Why this exists

Most habit apps optimize for *gentleness*. You missed your run? Here's a soft "let's try again tomorrow."

This isn't that.

The daemon takes you at your word when you say *"I want to row five days a week or I lose $50."* It does not negotiate. It does not soften. It checks the actual Concept2 API, sees no session, and triggers the stake. The point isn't punishment — it's **uncoupling the moment of weakness from the moment of consequence**. You decided what mattered on Sunday. The daemon enforces Sunday's decision on Tuesday morning, when your Tuesday-morning self would prefer to renegotiate.

If that sounds harsh: it's exactly as harsh as you make it. Set stakes you can live with.

---

## Status

| Phase | Scope | Status |
|---|---|---|
| **A** — walking skeleton | scheduler, three habits firing, sensor verification end-to-end | in progress |
| **B** — intelligence layer | miss classification, adaptive replanning proposals | not started |
| **C** — Sunday review | weekly review verb, three-reaction proposal UX | not started |

Built as a single-user, single-host, single-timezone tool. No SaaS aspirations, no multi-tenant fantasies — the design intentionally optimizes for one person and one machine.

---

## Project layout

```
src/
├── daemon/        scheduler loop, dispatch, ledger, kill switch, heartbeat
├── db/            sqlite connection, migration runner, migration .sql files
└── index.ts       entry barrel

tests/             vitest (unit + smoke), table-driven where possible
ARCHITECTURE.md    full technical design
LICENSE            MIT
```

---

## License

[MIT](./LICENSE) · © 2026 Maxwell Collins
