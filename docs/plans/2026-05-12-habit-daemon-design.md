# habit-daemon — Design

**Status:** Validated (brainstorming complete, 6 sections locked)
**Date:** 2026-05-12
**Authors:** Maxwell Collins (founder), Claude (orchestrator)
**Method:** `superpowers:brainstorming` skill, section-by-section validation

---

## Purpose

Build a persistent, conversational habit-accountability agent that lives in
Discord. It tracks three specific habits, demands real-data proof, escalates
through a tone ladder when the user doesn't comply, captures stated reasons
for misses at moment-of-freshness, detects cross-day patterns, and proposes
adaptive plan changes at weekly review.

The system is built as a fork of the `Property-Linkware-v2.1` daemon
orchestrator. The forked starting point is taken at commit-v1 and then
diverges. Zero cross-coupling between the two daemons at runtime.

The user is a detrained athlete recovering from a T9-T12 compression
fracture, running on sympathetic-dominant load from a build-mode SaaS, with
family livelihood tied to the build shipping. The mechanism every habit
serves is preserving the body that has to last the build.

---

## Section 1 — System shape & architecture

**Repo:** new `habit-daemon` repo, separate from `Property-Linkware-v2.1`.
PLW commit history stays clean; habit-bot has its own lifecycle, deployment,
and SQLite.

**Forked from PLW (copied at v1 commit, then diverges):**
- `scheduler-daemon.ts` — the long-lived Node.js process under its own
  systemd unit (`habit-daemon.service`). Polls a `schedules` table every
  30s. Watchdog keepalive. Graceful shutdown on SIGTERM. Identical pattern,
  separate process.
- `scheduler.ts` + `cron-parser.ts` — the cron engine. Each habit registers
  cron expressions.
- `sdk-dispatch.ts` — the `claude -p` spawn wrapper. Same `--json-schema`,
  `--max-turns`, `--max-budget-usd`, structured-output gate.
- `session-store.ts` — hash-chained append-only event log. Audit trail for
  habit completions, miss reasons, conversation history.
- `ledger.ts`, `kill-switch.ts`, `verify-footer.ts` — shared discipline.

**New to this repo:**
- `src/orchestrate/habit-checkin.ts` — the dispatch verb the scheduler fires
  for each escalation level.
- `src/orchestrate/habit-review.ts` — the Sunday review verb.
- `src/orchestrate/evaluate-stage-b.ts` — wind-down stage-B resolver.
- `src/orchestrate/retry-unresolved-sensors.ts` — sensor retry cron.
- `src/orchestrate/classify-response.ts` — Phase B.
- `src/orchestrate/classify-miss-reason.ts` — Phase B.
- `src/lib/discord-adapter.ts` — bot listener (incoming messages) + webhook
  poster (outgoing).
- `src/lib/garmin-adapter.ts` — Node→Python bridge via `spawnSync`.
- `src/lib/concept2-adapter.ts` — Node-native fetch + OAuth client for
  Logbook API.
- `src/lib/vision-verify.ts` — Claude vision wrapper for PM5/training-log
  photo checks.
- `scripts/garmin_fetch.py` — Python shim using `python-garminconnect`.
  Returns JSON to stdout. Auth tokens cached at `~/.garminconnect/`.

**Runtime:** Two systemd units running side by side on the same machine.
`plw-scheduler.service` (PLW) and `habit-daemon.service` (this). Each owns
its own SQLite file and never reads the other. Zero cross-coupling.

---

## Section 2 — The three habits + data model

### Habits

| habit | cron | proof_type | proof_config |
|---|---|---|---|
| `morning-row` | `5 9 * * *` | `concept2_api+photo_fallback` | `{min_minutes: 10, lookup_window_hours: 2, fallback_required_at_level: 3}` |
| `strength-mwf` | `20 18 * * 1,3,5` | `training_log_photo` | `{min_log_entries: 3, vision_subject: "training_log"}` |
| `wind-down` | `0 22 * * 0-4` | `typed_msg+garmin_sleep` | `{stage_a_phrase: "shutting down", stage_a_window_min: 15, stage_b_threshold: "23:00"}` |

Friday and Saturday are excluded from `wind-down` (protected gaming nights).

### Tables (new, in `habit-state.db`)

```sql
habits(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,                -- 'row' | 'strength' | 'wind-down'
  cron_expr TEXT NOT NULL,
  why_stakes_json TEXT NOT NULL,       -- see schema below
  proof_type TEXT NOT NULL,
  proof_config_json TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

habit_runs(
  id TEXT PRIMARY KEY,
  habit_id TEXT NOT NULL REFERENCES habits(id),
  fire_date TEXT NOT NULL,             -- YYYY-MM-DD
  fired_at INTEGER NOT NULL,
  current_level INTEGER NOT NULL DEFAULT 1,
  next_escalation_at INTEGER,          -- NULL when terminal
  status TEXT NOT NULL CHECK (status IN
    ('pending','completed','missed','skipped','partial',
     'unresolved','unresolved_no_data')),
  completed_at INTEGER,
  proof_payload_json TEXT,
  skip_reason TEXT,
  UNIQUE(habit_id, fire_date)
);

proof_stages(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES habit_runs(id),
  stage TEXT NOT NULL,                 -- 'a' (typed msg) | 'b' (garmin sleep)
  satisfied BOOLEAN NOT NULL DEFAULT 0,
  satisfied_at INTEGER,
  data_json TEXT
);

miss_reasons(
  id TEXT PRIMARY KEY,
  habit_id TEXT NOT NULL REFERENCES habits(id),
  run_id TEXT NOT NULL REFERENCES habit_runs(id),
  miss_date TEXT NOT NULL,
  user_response_text TEXT,             -- NULL when no_response classification
  classification TEXT,                 -- 'gaming' | 'work-late' | etc. | 'no_response'
  inferred_specifics TEXT,             -- slug format: 'category:entity'
  key_entities_json TEXT,
  classification_confidence REAL,
  gap_metadata_json TEXT,
  created_at INTEGER NOT NULL
);

sensor_signals(
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                -- 'garmin' | 'concept2'
  payload_date TEXT NOT NULL,          -- YYYY-MM-DD
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE(source, payload_date)
);

plan_changes(
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  habit_id TEXT NOT NULL REFERENCES habits(id),
  prior_config_json TEXT NOT NULL,
  new_config_json TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  reverted_at INTEGER
);
```

Plus the reused-from-PLW `session_events` (hash-chained audit log) extended
with new event types: `habit_prompt_sent`, `habit_user_response`,
`habit_proof_received`, `habit_completed`, `habit_missed`,
`habit_skip_requested`, `habit_dodge_requested`, `proof_attempt_rejected`,
`proposal_emitted`, `proposal_applied`, `proposal_rejected`,
`proposal_discussion_opened`, `proposal_discussion_message`,
`proposal_resolved`, `plan_change_applied`.

### `schedules` table additions

The PLW `schedules` table gets a `dispatch_priority INTEGER NOT NULL
DEFAULT 100` column. Stage-B evaluator priority = 10. Row L1 priority =
100. Scheduler tick sorts by priority before dispatching synchronously
within a tick.

### why_stakes_json schema (structured, not freeform)

```json
{
  "stakes_well": {
    "primary": "12 months post T9-T12 compression fracture, recovery stalled",
    "secondary": "Family livelihood depends on Linkware shipping — body has to last the build",
    "tertiary": "Detrained athlete (former top-3 triathlon) trying to restore baseline"
  },
  "body_data_well": {
    "signal_mode": "prior_night",      // or "trailing_week_trend"
    "relevant_signals": ["sleep_onset_time", "rem_minutes", "deep_sleep_minutes", "hrv"],
    "anomaly_check": "any signal in bottom 20% of trailing 30-day baseline",
    "framing_template": "You slept {total_sleep_minutes}, REM {rem_minutes} (bottom {percentile}%). {habit_name} is the parasympathetic primer for tonight's sleep, not just today."
  },
  "pattern_well": {
    "lookback_days": 28,
    "trigger_threshold": 3,
    "framing_template": "{count}{ordinal} {weekday} in {timeframe}. There's something about {weekday}. We figure it out now or it becomes the pattern."
  }
}
```

`signal_mode` varies per habit:
- `morning-row`, `strength-mwf`: `signal_mode: "prior_night"` (uses last
  night's data).
- `wind-down`: `signal_mode: "trailing_week_trend"` (tonight hasn't
  happened; uses 7-day rolling averages vs 30-day baseline).

### State machine

```
pending ─(proof verified)──→ completed
pending ─(stage-A only)────→ partial ─(stage-B verified)──→ completed
                             partial ─(stage-B fails)────→ missed
pending ─(L5 reached)──────→ missed
pending ─(skip ≥20 chars)──→ skipped
pending ─(sensor fail)─────→ unresolved ─(48h retry exhausted)──→ unresolved_no_data
unresolved ─(sensor returns)──→ completed | missed
```

### Claude context per invocation

Built from: the habit row (cron, why_stakes, proof config), the active
run's current state, last 20 `session_events` for this habit, any
`miss_reasons` rows from the trailing 30 days for pattern lookup, and the
day's `sensor_signals` (Garmin sleep, Concept2 sessions). All compiled into
the system prompt at dispatch time.

---

## Section 3 — Escalation engine

### Per-habit cron + escalation cadence

- **`morning-row`** — L1 fires at `5 9 * * *`. Escalation steps every 30
  min: L2 9:35, L3 10:05, L4 10:35, L5 11:05. After L5: `status=missed`,
  halt.
- **`strength-mwf`** — L1 fires at `20 18 * * 1,3,5`. Same 30-min cadence:
  L2 18:50, L3 19:20, L4 19:50, L5 20:20.
- **`wind-down`** — tight window. L1 fires `0 22 * * 0-4` (10:00pm). L2 at
  10:08, L3 at 10:13 (WHY hammer with 2 min left), L4 at 10:15 (window
  closes — "Window closed. Garmin will tell us the rest."). If "shutting
  down" arrives by 10:15, `partial`. Stage B evaluator at 9:00am next
  morning resolves to `completed` or `missed`.

### Polling loop (in `scheduler.ts`, ticks every 30s)

```
for each row in habit_runs WHERE next_escalation_at <= now AND status='pending':
  dispatch habit-checkin verb with { run_id, current_level }
  habit-checkin generates message via Claude, posts to Discord channel
  UPDATE habit_runs SET current_level = current_level + 1,
                       next_escalation_at = computed_next_time
  IF current_level > 5: UPDATE status='missed', next_escalation_at=NULL
```

### L3 WHY-well selection logic (deterministic, not LLM-freeform)

```
if (pattern_detector(28d).count >= 3
    AND last_pattern_well_use_at < now() - 14 days):
  use pattern_well
else if (body_data_anomaly_detected()):
  use body_data_well
else:
  use stakes_well (rotate primary → secondary → tertiary,
                   dedup against last 7 days)
```

Pattern beats anomaly because patterns require systemic intervention while
anomalies require effort. 14-day cooldown prevents same-drum-repeated.

L4 generates without new WHY content — direct callout only. L5 posts final
message, sets `status='missed'`, halts.

### Stage-B before row L1

Two enforcement mechanisms:
1. `dispatch_priority` column on `schedules`. stage-B priority=10, row L1
   priority=100. Scheduler tick sorts by priority.
2. Row L1 verb has a defensive guard at entry: `SELECT 1 FROM habit_runs
   WHERE habit_id='wind-down' AND status='partial' AND fire_date=yesterday()
   LIMIT 1` — if found, defer self by 60s.

Belt + suspenders.

### Dodge classifier (Claude, not regex) — Phase B

New verb `classify-response` invoked on every user reply in a habit channel
during an active run. Returns:

```ts
{
  is_dodge: boolean,
  extracted_time?: string,         // ISO 8601 if explicit time committed
  vague: boolean,                  // true if "later", "in a bit", "soon"
  is_completion_claim: boolean,    // "did it", "just finished"
  original_text: string
}
```

Routing:
- Explicit time → `UPDATE habit_runs SET next_escalation_at = extracted_time`
  + ack ("Locked in. Check back at HH:MM.")
- Vague → log as `habit_dodge_requested`, no reschedule, escalation continues
- 2+ dodges in single run (`SELECT COUNT(*) FROM session_events WHERE
  run_id=? AND event_type='habit_dodge_requested'` ≥ 2) → next level
  message hard-codes prior commitments: "You said {time1}, then {time2}.
  We're going to L3 now."

### Vision rejection escalation policy

On each `proof_attempt_rejected` event, `next_escalation_at` stays
UNCHANGED. Escalation continues on the locked timeline. At ≥3 rejections in
a single run, bot posts: "That's three photos that aren't the
{expected_subject}. What's going on?" Locks gaming-the-timer.

---

## Section 4 — Proof verification & post-miss interview

### Concept2 Logbook API flow (`src/lib/concept2-adapter.ts`)

- One-time setup: register OAuth client at log-dev.concept2.com →
  `CLIENT_ID + CLIENT_SECRET` → store at
  `~/.habit-daemon/concept2-credentials.json`.
- One-time user auth: daemon prints auth URL → user authorizes in browser →
  callback exchanges code for `access_token + refresh_token` → cached at
  `~/.habit-daemon/concept2-tokens.json`. Auto-refresh on 401.
- Per-row verify: `GET /api/users/me/results?from=<window_start_iso>&to=<window_end_iso>`
  with `Authorization: Bearer <token>`. Pagination handled (Logbook default
  page=50; row window ≤ 1 day so single page suffices).
- Verification: at least one session with `duration_seconds >= 600` (10 min)
  within the morning window, ErgData-synced from PM5.
- Cached in `sensor_signals(source='concept2', payload_date=YYYY-MM-DD)`.

**Row window contract:** Row counts only if completed before L5 fires
(11:05am for default schedule). Sessions arriving after L5 cache to
`sensor_signals` for diagnostics + Sunday-review surfacing, but
`habit_runs.status` stays `missed`. The L5 transition is the contract.

### Garmin Connect flow (`src/lib/garmin-adapter.ts` + `scripts/garmin_fetch.py`)

- Python shim: `python-garminconnect` (cyberjunky, PyPI), login once with
  email + password + MFA, tokens auto-refresh at `~/.garminconnect/`.
- Invocation: `spawnSync('python', ['scripts/garmin_fetch.py', '--date',
  date, '--fields', 'sleep_onset_time,total_sleep_minutes,rem_minutes,
  deep_sleep_minutes,hrv'])` returns JSON on stdout.
- Node side parses, validates schema, caches to
  `sensor_signals(source='garmin', payload_date=YYYY-MM-DD)`.
- Failure modes: MFA expired → daemon posts to `#sleep`: "Garmin auth needs
  refresh — re-login required." Network failure → retry every 6h for 48h.

**No self-report fallback for sensor failures.** Status becomes
`unresolved` and is excluded from compliance math. After 48h of failed
retries, `unresolved_no_data` is terminal. Surfaced in Sunday review as
infrastructure issue, not behavioral.

(Photo fallback for Concept2 remains valid because vision verification is
mechanical via Claude vision, not self-report — different case.)

### Vision verification (`src/lib/vision-verify.ts`)

```ts
const VISION_REGISTRY = {
  training_log: {
    prompt: "Verify this is a photo of a workout/training log. Confirm: ≥3
             distinct lift entries are visible, each entry shows lift name
             + weight + reps. Return JSON: { is_training_log: bool,
             entries_visible: number, confidence: 0-1,
             rejection_reason?: string }",
    schema: { is_training_log: 'boolean', entries_visible: 'number',
              confidence: 'number', rejection_reason: 'string?' }
  },
  pm5_screen: {
    prompt: "Verify this is a photo of a Concept2 PM5 monitor showing a
             completed rowing session. Confirm: duration ≥ 10:00, meters
             visible, screen shows completed (not in-progress) session.
             Return JSON: { is_pm5: bool, duration_minutes: number,
             meters: number, completed: bool, confidence: 0-1,
             rejection_reason?: string }",
    schema: { is_pm5: 'boolean', duration_minutes: 'number',
              meters: 'number', completed: 'boolean', confidence: 'number' }
  }
};
```

Adding new proof types requires a registry entry, not ad-hoc prompts in
habit configs.

### Two-stage wind-down resolution

- 10:00pm L1 fires. User types "shutting down" → `classify-response`
  detects completion claim for stage A → `proof_stages.a.satisfied=true` →
  `status='partial'` → bot ack: "Got it. Garmin will tell us the rest."
- 9:00am stage-B cron: per-`partial`-row, pull `sensor_signals[garmin]
  .sleep_onset_time`, compare to `stage_b_threshold (23:00)`. Pass →
  `status='completed'`, post to `#wins`. Fail → `status='missed'`, log
  `gap_metadata_json: {stage_a_time, stage_b_actual_onset, gap_minutes}` to
  `miss_reasons`, post curious follow-up to `#wind-down`.

### Post-miss interview pattern (universal across habits)

**Trigger:** `status` transitions to `missed`, or stage-B fails, or any L5
hits.

**Flow:**
1. Bot posts curious-tone prompt in habit channel (template per habit).
   Example for wind-down: "Morning Max. Quick note before the row — you said
   shutting down at {stage_a_time} but Garmin shows asleep at
   {stage_b_actual}. What happened in those {gap_minutes} minutes? No
   judgment, just want to know what we're working with."
2. Listener awaits response (NO escalation during interview window — 2 hours
   of listening).
3. Response arrives → `classify-miss-reason` verb invokes Claude with the
   response text + last 30d of miss_reasons + habit context.
4. Stored in `miss_reasons` table with full original text + classifier output.

**Classifier output schema (slug-format enforced):**
```ts
{
  classification: string,           // top-level category
  inferred_specifics: string,       // slug "category:entity"
  key_entities: string[],
  confidence: number
}
```
Examples: `late-gaming-friend:brian`, `late-work:linkware-deploy`,
`flare-up:lower-back`, `travel:nyc`, `sick:flu`.

**No-response handling:** If user doesn't respond within 2-hour interview
window, `miss_reasons` row stored with `user_response_text = NULL` and
`classification = 'no_response'`. No same-day follow-up (preserves
curious-not-punitive contract). Pattern detector treats `no_response` as
its own category — 3+ unanswered interviews in 30 days surfaces in Sunday
review as **avoidance pattern**.

**Pattern detection:**
```sql
SELECT inferred_specifics, COUNT(*)
FROM miss_reasons
WHERE habit_id=? AND created_at >= now()-30d
GROUP BY inferred_specifics
HAVING COUNT(*) >= 3
```
Pattern detector matches on slug prefix (`late-gaming-friend:%`) for
category counts, and full slug for entity-precise mentions. Inline message
at 5+ becomes: "5th late-gaming-friend:brian this month — want to talk
about whether Tuesday gaming nights should join the protected-exception
list?"

### Skip handling

User types `skip` command in any habit channel during a pending run. Bot
parses message. Required: reason text ≥ 20 chars. Below threshold → bot
replies asking for more context: "That's not enough to help me see the
pattern. What's actually going on?"

Status becomes `skipped` (distinct from `missed`). Compliance math treats
skip as non-completion but tagged separately. Pattern detector triggers if
skips exceed 2/week for any habit → surfaced in Sunday review.

---

## Section 5 — Discord surface & Sunday review

### The five channels (private server, you + the bot)

| Channel | Who posts | What appears |
|---|---|---|
| `#morning-row` | bot + you | L1–L5 prompts, your responses, PM5 photos, Concept2 API confirmations, post-miss interviews |
| `#strength` | bot + you | M/W/F L1–L5, training-log photos, vision verification ack/reject |
| `#wind-down` | bot + you | 10pm prompts, "shutting down" message, next-morning Garmin resolution + curious follow-up if gap |
| `#wins` | bot only | Completion log. One line per completion. Read-only positive scroll. No annotations. |
| `#sunday-review` | bot only | Weekly synthesis post (Sunday 8pm). Editable thread for your responses to proposals. |

### Bot listener mechanics (`discord-adapter.ts`)

- Subscribed to `MessageCreate` on the 3 active channels (`#morning-row`,
  `#strength`, `#wind-down`).
- On every message: look up active `habit_runs` row by `channel_id` +
  author match + `status IN ('pending', 'partial')` within the day's fire
  window.
- If active run found → fire `classify-response` verb. Routes:
  - `is_completion_claim && has_attachment` → `verify-proof` verb
  - `is_completion_claim && !has_attachment` → bot asks for proof ("Photo?")
  - `is_dodge && extracted_time` → lock new escalation time
  - `is_dodge && vague` → log, no reschedule
  - Default → log as `habit_user_response`, dispatch `respond` verb for
    Claude-generated contextual reply
- If no active run (idle channel) → store as `out_of_band_message` event,
  no dispatch.

### `#wins` format — bare facts only, no annotations

```
✓ Morning row · 9:42 · 12 min · 2,143m
✓ Strength · Wed 7:08pm · 4 lifts logged
✓ Wind-down · stage A 22:08 · Garmin asleep 22:55
```

All `status = completed` rows post identically. No "barely made it"
interpretations, no "clean," no qualifiers. Reader infers gaps. Wind-down
always posts both stage-A timestamp and Garmin onset, regardless of gap
size. Moralizing narrow wins violates the same no-moralizing constraint as
moralizing misses.

### Sunday review verb (`habit-review.ts`, cron `0 20 * * 0`)

Sunday 8pm — post meal-prep block, week is fresh in memory, no competing
morning routine.

Pulls all data for the week (Mon→Sun):
- Completion rate per habit
- Misses with classifications (joined from `miss_reasons`)
- Skips with reasons
- `no_response` count per habit
- Slug-grouped pattern counts (30-day window for context)
- Sensor data: avg sleep_onset_time, avg total_sleep, avg row sessions,
  strength session count

Builds a structured prompt to Claude with all that data + the
why_stakes_json. Claude generates a synthesis with four required sections:

1. **What the week looked like** — tabular summary, no editorial.
2. **Patterns I noticed** — bulleted, each pattern cites the slug and count.
   Categories: behavioral patterns (`late-gaming-friend:brian` 4× this
   month), avoidance patterns (`no_response` 3× this month), infrastructure
   patterns (Garmin failed 2× this week).
3. **Stable surfaces** — habits with 14+ consecutive completions or zero
   misses in trailing 30 days. Factual format, no praise language.
   Example:
   ```
   - Morning row: 14 consecutive completions. Row time avg shifted 9:12 → 9:07.
   - Strength M/W/F: 6 consecutive sessions completed within target window.
   ```
   Symmetric with patterns section (both are observation, neither is
   moralizing). Stable surfaces are diagnostic signal for which habits can
   be built on top of in future plan changes.
4. **Proposals** — only if a pattern threshold triggered (3+ in 30d for
   behavioral, 3+ for avoidance, 2+ for infrastructure). Each proposal is a
   concrete edit. Proposals posted as Discord poll/thread.

### Three-reaction proposal UX

- ✅ **Apply** → writes `proposal_applied` event, updates `habits` row,
  posts confirmation, prior config preserved in event chain for reversal.
- ❌ **Reject** → bot follow-up: "What made this not right?" → captures
  reasoning text → writes `proposal_rejected` event with reason field.
- 💬 **Discuss** → opens Discord thread under the review post. Bot
  generates 2-3 clarifying questions. Each user reply captured as
  `proposal_discussion_message` event. Thread resolves to one of:
  `applied` / `rejected` / `counter_proposal_emitted` (new `proposal_id`
  chained to parent) / `deferred` (re-evaluate at next Sunday review).
  Resolution writes `proposal_resolved` event.

Binary accept/reject inflates rejection rate by forcing nuanced reactions
into hard-no. Most real adaptive planning lives in the 💬 path.

### Adaptive plan-change application

When proposal is ✅'d, bot writes a `plan_change_applied` event to
`session_events` (audit chain), updates the relevant `habits` row, posts
confirmation. Plan changes are reversible — bot keeps prior config in event
log and `plan_changes` table.

---

## Section 6 — MVP build sequencing

**Three-phase critical path. Each phase ends in a shippable, gated,
soak-tested system. No time estimates — only correctness criteria.**

### Phase A — Walking skeleton with full sensor stack

End state: All three habits live, Concept2 + Garmin + Claude vision
verifying proof, all 5 channels active, full L1–L5 escalation engine with
deterministic L3 WHY-well selection.

Build set:
- Fork PLW daemon files into `habit-daemon` repo.
- Migration `001_habits.sql` with all 7 tables (`habits`, `habit_runs`,
  `proof_stages`, `miss_reasons`, `sensor_signals`, `plan_changes`, plus
  PLW's `session_events` and `schedules` with `dispatch_priority` column).
- `concept2-adapter.ts` with OAuth client + auto-refresh on 401.
- `garmin-adapter.ts` Node→Python bridge.
- `scripts/garmin_fetch.py` using `python-garminconnect`.
- `vision-verify.ts` with `VISION_REGISTRY`: `pm5_screen`, `training_log`.
- `discord-adapter.ts`: webhook poster + listener on the 3 active channels.
- 5 channels live (`#sunday-review` idle in Phase A).
- Seed all three habits with full `why_stakes_json` (stakes, body-data
  per-habit signal_mode, pattern_well structure populated even though
  dormant).
- Verbs: `habit-checkin`, `verify-proof`, `evaluate-stage-b` (cron
  `0 9 * * *`), `retry-unresolved-sensors` (cron `0 */6 * * *`).
- L3 WHY-well selection logic in `habit-checkin`:
  - pattern_well checked first; **no-ops gracefully on insufficient data**
  - body_data_well checked second; uses cached sensor signals
  - stakes_well as default; rotates with 7-day dedup
- L1–L5 escalation engine with `next_escalation_at` polling.
- Dodge classifier deferred to Phase B — Phase A handles only explicit
  completion claims and proof attachments.
- systemd unit `habit-daemon.service` with watchdog.

**Soak-pass criteria for Phase A:**
- daemon uptime > 99%
- all scheduled fires dispatched (no missed cron ticks)
- vision verification accuracy > 95% on user-submitted photos
- sensor sync success > 95% (Garmin pulls + Concept2 pulls)
- stage-B resolution: 100% of `partial` runs resolve to
  `completed`/`missed`/`unresolved` within 24h
- L3 stakes_well rotation observed working
- L3 body_data_well firing observed when sensor anomalies present
- **L3 selection-logic falsifiability:** if no L3 fires occur organically
  during soak (because compliance is high), end-of-phase test plan includes
  one manual L3 trigger per habit (simulated miss) to verify the selection
  logic. Without this, the L3 criteria are unfalsifiable.

End of Phase A: real-data end-to-end loop running, accumulating
`miss_reasons` data that Phase B's pattern_well will consume.

### Phase B — Intelligence layer

End state: Bot is fully conversational. Post-miss interviews capture stated
reasons. Dodge classifier handles all user-response shapes. Pattern_well
activates as data accumulates past threshold.

Build set:
- `classify-response` verb (dodge, completion claim, vague handling).
- Routing: explicit time → lock; vague → log; completion-claim without
  attachment → bot asks for proof.
- Multi-dodge callout at next level.
- Vision-rejection counter (3+ → callout, no timer reset).
- Post-miss interview engine: 2h listener window opens at `status='missed'`
  or stage-B fail.
- `classify-miss-reason` verb with slug-format output.
- No-response handling: 2h timeout writes `classification='no_response'`.
- Skip command parsing: ≥20-char reason required.
- Pattern_well activation: `pattern_detector(28d, slug-prefix-grouped) >= 3`
  AND `last_pattern_well_use < now() - 14d`.

**Soak-pass criteria for Phase B (additive to Phase A):**
- WHY-well selection at each L3 logged with reasoning and reviewable in
  `session_events`
- post-miss interview response rate > 70%
- dodge classifier accuracy > 90% on a labeled set of user responses
  (~30 hand-labeled examples constructed during Phase B)
- slug-format classification consistency > 90%
- pattern_well fires at least once on real accumulated data

### Phase C — Sunday review + proposal flow

End state: Weekly synthesis self-emits. Three-reaction proposal UX handles
apply/reject/discuss paths. Plan changes apply with reversible audit chain.

Build set:
- `habit-review` verb (cron `0 20 * * 0`).
- Review report generator: 4-section structure (week summary · patterns ·
  stable surfaces · proposals).
- Proposal emission with `proposal_id`.
- Discord reaction handler: ✅/❌/💬 routing.
- Discussion thread flow.
- Plan-change application with `plan_change_applied` audit event.
- Counter-proposal chaining via `parent_proposal_id`.
- Plan-change reversibility via `plan-change-revert` verb.

**Soak-pass criteria for Phase C (additive to Phase B):**
- Sunday review fires reliably at `0 20 * * 0`
- all three reaction paths exercised (apply, reject with reason capture,
  discuss with thread resolution)
- plan changes apply correctly and are reversible
- counter-proposals chain correctly with `parent_proposal_id`
- stable-surfaces section accurate (cross-validated against `habit_runs`)

### Universal phase gate-shape

Each phase ends with all of:
1. `pnpm typecheck` clean.
2. `pnpm build` clean.
3. `pnpm test:smoke` passing.
4. Soak run meeting that phase's pass criteria.
5. Retro written to `docs/retros/phase-{A,B,C}-retro.md` with structure:
   **Worked** · **Failed** · **Surprised** · **Changes to subsequent phase
   specs**.
6. Next phase's spec read against the retro's "Changes" section before
   build begins.

### Soak-failure response tree

When a soak run fails any pass criterion, retro classifies the root cause:
- **Implementation failure** (code didn't match spec) → re-run phase build,
  no spec change.
- **Design failure** (spec was wrong) → revise phase design doc → update
  spec → re-run phase build from corrected spec.
- **Regression** (prior phase functionality broken by current phase
  changes) → roll back to prior phase tag → identify breaking change → fix
  isolated → re-run current phase.

### Pre-Phase-A logistics (one-time, not in any phase's build set)

- Register Discord bot at discord.com/developers, create application,
  generate bot token, add to private server with admin permissions.
- Register Concept2 OAuth client at log-dev.concept2.com → `CLIENT_ID` +
  `CLIENT_SECRET`.
- Run `scripts/garmin_fetch.py --login` once with email + password + MFA
  code to seed `~/.garminconnect/` token cache.
- Initialize `habit-daemon` repo, install systemd unit.

All credentials live in `~/.habit-daemon/credentials.json` (gitignored,
never in repo).

---

## Open questions for next iteration

None blocking Phase A start. Items deferred for later phases:

- `completed_late` status with 15-min grace window past L5 — deferred to
  V1.5 once Phase A data shows whether the on-time-failure pattern is worth
  bucketing distinctly.
- Multi-user generalization (V2+) — current design is single-user.
- Voice-call escalation (Twilio) — explicitly rejected at L5 ceiling
  decision; revisit only if accumulated `miss` patterns suggest text
  ceiling is insufficient.
- Public-channel shame escalation — same as above.
- Money-on-the-line escalation — same as above.

---

*End of design. Validated section-by-section via `superpowers:brainstorming`.
Ready for Phase A implementation plan via `superpowers:writing-plans`.*
