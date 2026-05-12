# Architecture

habit-daemon is a single long-running Node.js process backed by a local SQLite database (`habit-state.db`). It owns four concerns: scheduling, dispatch, proof verification, and weekly review.

## Process shape

One process. WAL-journal SQLite for concurrent reader/writer durability. Foreign keys enforced. Embedded scheduler loop (polls every 30s by default). Verb dispatch via in-process function map. Discord I/O via a single `discord.js` client owning all five channels. Subprocess calls only for: the Garmin fetch script (Python), and a Concept2 OAuth callback listener (transient, only during initial auth).

## Data model

Six tables. The first three are the core habit-lifecycle tables; the latter three support intelligence and adaptive replanning.

### Core lifecycle

- **`habits`** — habit definitions: `id`, `name`, `domain` (`row` | `strength` | `wind-down`), `cron_expr`, `why_stakes_json`, `proof_type`, `proof_config_json`, `channel_id`, `active`, `created_at`.
- **`habit_runs`** — one row per `(habit_id, fire_date)`. Tracks `current_level` (1/2/3), `next_escalation_at`, `status` (`pending` | `completed` | `missed` | `skipped` | `partial` | `unresolved` | `unresolved_no_data`), `completed_at`, `proof_payload_json`, `skip_reason`, `proof_rejection_callout_due`.
- **`proof_stages`** — multi-stage proof records (currently used by wind-down: stage `a` = typed message, stage `b` = Garmin sleep window). Each stage has `satisfied`, `satisfied_at`, `data_json`.

### Intelligence + adaptive

- **`miss_reasons`** — captured user response when a habit run terminates without completion. Holds the user's text, an LLM classification (open vocabulary, no CHECK constraint), inferred specifics, key entities, and gap metadata.
- **`sensor_signals`** — append-only sensor payload archive. One row per `(source, payload_date)`. Sources today: `garmin`, `concept2`. Sources are an open string set — adding new sources does not require a schema migration.
- **`plan_changes`** — append-only audit log of habit-config changes proposed by Sunday review and accepted via Discord reaction. Each row records prior config JSON, new config JSON, and a nullable `reverted_at`.

## Scheduling

Cron expressions are interpreted in the deployment host's local timezone (single-user, single-timezone deployment). The scheduler maintains an in-database `schedules` table with one row per active habit, storing `cron_expr`, `enabled`, `last_run_iso`, `next_run_iso`, `missed_run_policy` (`skip` | `catchup` | `fail`), and `dispatch_priority`.

Each tick:

1. Read all enabled schedules, ordered by `dispatch_priority ASC, id ASC`.
2. Compute due-ness via the local-time cron parser.
3. For each due schedule: dispatch the verb, update `last_run_iso` + `next_run_iso`, apply `missed_run_policy` if the gap covers multiple missed slots.
4. Re-arm the tick timer.

The scheduler does **not** own habit-state transitions (level increments, completion). It only fires the verb. The verb owns the state machine.

## Escalation

Per-habit escalation cadence comes from `why_stakes_json.escalation`. The habit-checkin verb reads `current_level`, picks the prompt template for that level, posts to the habit's channel, then sets `next_escalation_at` to "now + cadence[current_level]". When the scheduler ticks at `next_escalation_at` and the habit is still `pending`, the verb runs again with `current_level += 1`.

At L3, the verb selects one stake from `why_stakes_json.stakes[]` deterministically (hash of `(habit_id, fire_date)`), surfacing the financial/relational cost the user pre-committed.

## Proof verification

Proof types are pluggable per habit. Today:

- **`concept2_session`** (row habits) — fetch the user's most-recent Concept2 session via the Logbook OAuth API, verify `(distance_meters, duration_seconds, type)` against `proof_config_json.window`.
- **`garmin_sleep_window`** (wind-down habits) — fetch yesterday's sleep record via the Garmin Connect adapter, verify the user was in bed before the configured threshold (e.g., `"23:00"`).
- **`claude_vision`** (strength habits) — accept an image upload in the habit's Discord channel, route it through Claude's vision API with a habit-specific evaluation prompt, accept/reject the photo as proof.

Each proof verification writes back a `proof_payload_json` on the run and updates `status` to `completed` (verified), `partial` (some stages satisfied), or leaves it `pending` (rejected; user can re-attempt before the next escalation).

## Sensor adapters

- **Concept2** — TypeScript OAuth flow (authorization code, callback on `http://localhost:8765/concept2/callback`). Credentials in `~/.habit-daemon/concept2-credentials.json`. Tokens cached to `~/.habit-daemon/concept2-tokens.json` with auto-refresh.
- **Garmin** — Python adapter using the `garminconnect` library, invoked via subprocess from a TypeScript wrapper. First-run requires interactive MFA. Token cache at `~/.garminconnect/garmin_tokens.json`.
- **Claude** — Anthropic SDK direct calls. Vision uses the standard messages API with image content blocks.

## Discord surface

A single `discord.js` client connects with `Guilds | GuildMessages | MessageContent` intents. The bot owns five channels per habit domain:

- `#morning-row` — row habit prompts and completions
- `#strength` — strength habit prompts, photo proof uploads
- `#wind-down` — wind-down prompts, stage-a typed responses
- `#wins` — bare-facts daily completion log (`✓` only, no commentary)
- `#sunday-review` — weekly review proposals with three-reaction UX

The bot listens for: typed user responses (miss reason capture, wind-down stage A), image attachments (vision proof), and reactions on Sunday review messages (accept/reject/modify plan changes).

## Sunday review

A weekly verb (`habit-review`) runs Sunday evening. It aggregates the week's `habit_runs`, classifies each miss via the `miss_reasons` LLM, identifies adaptive replanning opportunities (e.g., "your row miss correlates with late work sessions four out of five times"), and posts proposals to `#sunday-review`. Each proposal carries three reaction emoji for accept / reject / open dialogue. Accepted proposals write to `plan_changes` and update `habits.proof_config_json` or `habits.cron_expr` accordingly.

## Reliability

- WAL journal mode with periodic checkpoint (default 10 min).
- Heartbeat file written every tick; a sibling watchdog (or systemd/launchd) can monitor staleness.
- Kill switch: a sentinel file path that, when present, causes the dispatch path to short-circuit and skip rather than fire.
- Structured-output verification: every LLM dispatch returns a typed footer (Zod schema) that's validated before the run is recorded.
- Append-only hash chain over dispatch events for tamper-evident audit.

## Build, test, gate

Standard pnpm pipeline:

```sh
pnpm gate   # = pnpm typecheck && pnpm build && pnpm test
```

Tests are Vitest. Source TypeScript compiles to `dist/`. Migrations live in `src/db/migrations/*.sql` and run on daemon startup via the migration runner (`src/db/migrate.ts`).
