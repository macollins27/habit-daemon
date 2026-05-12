# Architecture

habit-daemon is a single long-running Node.js process backed by a local SQLite database (`habit-state.db`). It owns four concerns: scheduling, dispatch, proof verification, and weekly review.

## Process shape

One process. WAL-journal SQLite for concurrent reader/writer durability. Foreign keys enforced. Embedded scheduler loop (polls every 30s by default). Verb dispatch via in-process function map. Discord I/O via a single `discord.js` client owning all five channels. Subprocess calls only for: the Garmin fetch script (Python), and a Concept2 OAuth callback listener (transient, only during initial auth).

## Data model

Six application tables plus a hash-chained audit log. The first three application tables are the core habit-lifecycle tables; the next three support intelligence and adaptive replanning. The audit chain (`sessions` + `session_events`) is shared infrastructure inherited from the daemon-orchestrator lineage and is described separately below.

### Core lifecycle

- **`habits`** — habit definitions: `id`, `name`, `domain` (`row` | `strength` | `wind-down`), `cron_expr`, `why_stakes_json`, `proof_type`, `proof_config_json`, `channel_id`, `active`, `created_at`.
- **`habit_runs`** — one row per `(habit_id, fire_date)`. Tracks `current_level` (1 through 5), `next_escalation_at`, `status` (`pending` | `completed` | `missed` | `skipped` | `partial` | `unresolved` | `unresolved_no_data`), `completed_at`, `proof_payload_json`, `skip_reason`, `proof_rejection_callout_due`.
- **`proof_stages`** — multi-stage proof records (used by wind-down: stage `a` = typed message, stage `b` = Garmin sleep window). Each stage has `satisfied`, `satisfied_at`, `data_json`.

### Intelligence + adaptive

- **`miss_reasons`** — captured user response when a habit run terminates without completion. Holds the user's text, an LLM classification (open vocabulary, no CHECK constraint), inferred specifics in slug format `category:entity`, key entities, classifier confidence, and gap metadata.
- **`sensor_signals`** — append-only sensor payload archive. One row per `(source, payload_date)`. Sources today: `garmin`, `concept2`. Sources are an open string set — adding new sources does not require a schema migration.
- **`plan_changes`** — append-only record of habit-config changes proposed by Sunday review and accepted via Discord reaction. Each row records `proposal_id`, prior config JSON, new config JSON, and a nullable `reverted_at`.

### Audit chain

- **`sessions`** — one row per dispatch session (`session_id`, `created_iso`, `parent_session`, `fork_uuid`, `status`).
- **`session_events`** — append-only hash-chained event log. Each row carries `seq`, `prev_hash`, `hash`, `trust_level` (L0–L4), and an `event_type` constrained by a SQLite `CHECK` to one of sixteen allowed values, grouped:
  - **Habit-flow (8):** `habit_prompt_sent`, `habit_user_response`, `habit_proof_received`, `habit_completed`, `habit_missed`, `habit_skip_requested`, `habit_dodge_requested`, `proof_attempt_rejected`.
  - **Proposal (7):** `proposal_emitted`, `proposal_applied`, `proposal_rejected`, `proposal_discussion_opened`, `proposal_discussion_message`, `proposal_resolved`, `plan_change_applied`.
  - **Infrastructure (1):** `sensor_failure_logged`.

  `UPDATE` and `DELETE` are blocked by triggers; the table is append-only by construction. The hash chain makes the audit trail tamper-evident.

## Scheduling

Cron expressions are interpreted in the deployment host's local timezone (single-user, single-timezone deployment). The scheduler maintains an in-database `schedules` table with one row per active habit, storing `cron_expr`, `enabled`, `last_run_iso`, `next_run_iso`, `missed_run_policy` (`skip` | `catchup` | `fail`), and `dispatch_priority`.

Each tick:

1. Read all enabled schedules, ordered by `dispatch_priority ASC, id ASC`.
2. Compute due-ness via the local-time cron parser.
3. For each due schedule: dispatch the verb, update `last_run_iso` + `next_run_iso`, apply `missed_run_policy` if the gap covers multiple missed slots.
4. Re-arm the tick timer.

`dispatch_priority` is load-bearing for wind-down. The stage-B evaluator (resolving last night's `partial` runs) is priority 10; morning-row L1 is priority 100. The lower number ticks first, so the previous night's wind-down resolves to `completed`/`missed` before the new day's row prompt fires. A defensive guard in the row L1 verb double-checks this and defers itself by 60s if a `partial` wind-down from yesterday is still open.

The scheduler does **not** own habit-state transitions (level increments, completion). It only fires the verb. The verb owns the state machine.

## Escalation

Five levels per run. Cadence is per-habit:

- **`morning-row`** — L1 at 9:05am, then 30-min steps: L2 9:35, L3 10:05, L4 10:35, L5 11:05.
- **`strength-mwf`** (Mon/Wed/Fri) — L1 at 6:20pm, same 30-min cadence: L2 6:50, L3 7:20, L4 7:50, L5 8:20.
- **`wind-down`** (Sun–Thu) — tight window. L1 at 10:00pm, L2 10:08, L3 10:13 (WHY hammer with two minutes left in the window), L4 10:15 (window closes).

At L5 the verb posts a final message and writes `status='missed'`. The poll loop then leaves the run alone — `next_escalation_at` goes NULL.

### L3 WHY-well selection (deterministic, not LLM-freeform)

`why_stakes_json` is structured into three "wells" — three independent sources of motivational content for the L3 prompt:

- **`stakes_well`** — three named stakes (`primary`, `secondary`, `tertiary`) describing what's on the line. Rotated `primary → secondary → tertiary` with a 7-day dedup against the last stake used.
- **`body_data_well`** — `signal_mode` (`prior_night` for row/strength, `trailing_week_trend` for wind-down), `relevant_signals` (e.g. `sleep_onset_time`, `rem_minutes`, `deep_sleep_minutes`, `hrv`), an `anomaly_check` rule, and a `framing_template`.
- **`pattern_well`** — 28-day lookback over `miss_reasons` grouped by slug. Triggers when count ≥ 3 and the well hasn't fired in 14 days. Dormant in Phase A while data accumulates.

At L3, the verb walks a deterministic priority chain:

1. If `pattern_detector(28d).count >= 3` AND `last_pattern_well_use_at < now() − 14 days` → use `pattern_well`.
2. Else if `body_data_anomaly_detected()` → use `body_data_well`.
3. Else → use `stakes_well` (with rotation + 7-day dedup).

Pattern beats body-data because patterns require systemic intervention while body-data anomalies require effort. The 14-day pattern cooldown prevents same-drum-repeated. The 7-day stakes rotation prevents the same line being recited two days running.

L4 issues a direct callout without new WHY content — the wells are exhausted for this run. L5 posts the final message and marks the run `missed`.

## Proof verification

Proof types are pluggable per habit, declared in `proof_type` + `proof_config_json`:

- **`concept2_api+photo_fallback`** (morning-row, config `{min_minutes: 10, lookup_window_hours: 2, fallback_required_at_level: 3}`) — primary path is the Concept2 Logbook API: a session with `duration_seconds >= 600` inside the morning window verifies the run. From L3 onward the bot will also accept a PM5 photo as fallback, routed through the `pm5_screen` vision template (≥ 10 min, meters visible, completed screen).
- **`training_log_photo`** (strength-mwf, config `{min_log_entries: 3, vision_subject: "training_log"}`) — photo uploaded to `#strength`, evaluated by the `training_log` vision template (≥ 3 distinct lift entries, each with lift name + weight + reps).
- **`typed_msg+garmin_sleep`** (wind-down, config `{stage_a_phrase: "shutting down", stage_a_window_min: 15, stage_b_threshold: "23:00"}`) — two stages; see below.

Vision verification lives in a `VISION_REGISTRY` keyed by `vision_subject`. Adding a proof shape means adding a registry entry, not editing habit configs ad hoc. Each proof attempt writes a `proof_payload_json` on the run and updates `status` to `completed`, `partial`, or leaves it `pending` (rejected; user can re-attempt before the next escalation). A rejection writes a `proof_attempt_rejected` event to the audit chain but does **not** advance the escalation timer. Three rejections in a single run flips `proof_rejection_callout_due`, and the next escalation prompt calls it out directly.

### Two-stage wind-down

Wind-down is the only habit that splits across days.

- **Stage A — same evening.** User types "shutting down" (or the configured phrase) in `#wind-down` by 10:15pm. `proof_stages.a.satisfied = true`, `status='partial'`, and the bot acks: "Got it. Garmin will tell us the rest."
- **Stage B — next morning.** A 9:00am cron (the `evaluate-stage-b` verb, priority 10 so it runs before row L1) loads each `partial` row, pulls `sensor_signals[garmin].sleep_onset_time`, and compares it to `stage_b_threshold` (default `23:00`). Pass → `status='completed'`, line posts to `#wins`. Fail → `status='missed'`, a `miss_reasons` row is written with `gap_metadata_json` capturing `stage_a_time`, `stage_b_actual_onset`, and `gap_minutes`, and the bot posts a curious follow-up to `#wind-down` ("you said shutting down at 22:08 but Garmin shows asleep at 22:55 — what happened in those minutes?").

Sensor outages don't fall back to self-report. Garmin retry runs every 6h for 48h; an unresolvable stage B becomes `unresolved` and then `unresolved_no_data`, surfaced in Sunday review as an infrastructure issue rather than a behavioral miss. The Concept2 photo fallback is different in kind — vision verification is mechanical, not self-attestation.

## Sensor adapters

- **Concept2** — TypeScript OAuth flow (authorization code, callback on `http://localhost:8765/concept2/callback`). Credentials in `~/.habit-daemon/concept2-credentials.json`. Tokens cached to `~/.habit-daemon/concept2-tokens.json` with auto-refresh on 401.
- **Garmin** — Python adapter using the `python-garminconnect` library, invoked via `spawnSync` from a TypeScript wrapper. First-run requires interactive MFA. Token cache at `~/.garminconnect/`. The Python script returns JSON on stdout; the Node side parses, validates schema, and caches into `sensor_signals`.
- **Claude** — Anthropic SDK direct calls. Vision uses the standard messages API with image content blocks.

## Discord surface

A single `discord.js` client connects with `Guilds | GuildMessages | MessageContent` intents. The bot owns five channels per habit domain:

- `#morning-row` — row habit prompts and completions, Concept2 confirmations, PM5 fallback photos.
- `#strength` — strength habit prompts, training-log photo uploads, vision accept/reject.
- `#wind-down` — 10pm prompts, "shutting down" message, next-morning Garmin resolution + curious follow-up if gap.
- `#wins` — bare-facts completion log, bot-only, no commentary. Wind-down lines post both stage-A timestamp and Garmin onset regardless of gap size.
- `#sunday-review` — bot-only weekly synthesis post, with editable threads for proposal discussion.

The bot listens on the three active channels for typed user responses (miss-reason capture, wind-down stage A, dodge classification in Phase B), image attachments (vision proof), and reactions on Sunday-review messages (the three-reaction proposal UX).

## Sunday review

The `habit-review` verb runs at `0 20 * * 0` (Sunday 8pm) and pulls the week's `habit_runs`, joined miss classifications, skip reasons, no-response counts, slug-grouped patterns over a 30-day window, and aggregated sensor signals. It builds a structured prompt that includes `why_stakes_json` and asks Claude to produce a synthesis with four required sections:

1. **What the week looked like** — tabular summary, no editorial.
2. **Patterns I noticed** — bulleted, each pattern citing its slug and count. Behavioral, avoidance (`no_response`), and infrastructure patterns each have their own thresholds.
3. **Stable surfaces** — habits with 14+ consecutive completions or zero misses in the trailing 30 days. Factual format, no praise language. Symmetric in tone with the patterns section: both are observation, neither is moralizing.
4. **Proposals** — only when a pattern threshold trips. Each proposal is a concrete config edit (cron, threshold, window, etc.), emitted with a `proposal_id`.

Proposals are posted with three reactions:

- **✅ Apply** — writes a `proposal_applied` event, updates the relevant `habits` row, and a corresponding `plan_change_applied` event captures the prior config for reversal. A `plan_changes` row records the diff.
- **❌ Reject** — bot follows up asking what made the proposal wrong; the response is captured in a `proposal_rejected` event.
- **💬 Discuss** — opens a Discord thread under the review post. The bot generates 2–3 clarifying questions; each user reply is logged as `proposal_discussion_message`. The thread resolves to `applied`, `rejected`, `counter_proposal_emitted` (with a new `proposal_id` chained to the parent), or `deferred`, recorded as `proposal_resolved`.

Binary accept/reject would inflate the rejection rate by forcing nuanced reactions into a hard "no." The discuss path is where most adaptive replanning is expected to happen.

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
