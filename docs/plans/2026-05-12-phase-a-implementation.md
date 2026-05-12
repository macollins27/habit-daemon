# Phase A Implementation Plan — habit-daemon

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Walking skeleton with full sensor stack — all three habits live, Concept2 + Garmin + Claude vision verifying proof, all 5 Discord channels active, full L1–L5 escalation engine with deterministic L3 WHY-well selection.

**Architecture:** Fork PLW v1 daemon files into new `habit-daemon` repo. Reuse scheduler-daemon, sdk-dispatch, session-store, ledger, kill-switch, verify-footer. New code: habit-checkin/verify-proof/evaluate-stage-b/retry-unresolved-sensors verbs, discord-adapter, concept2-adapter, garmin-adapter (Node→Python), vision-verify. SQLite stays single-file (habit-state.db). systemd-supervised.

**Tech Stack:** Node.js 20, TypeScript strict, Vitest, better-sqlite3, Anthropic Claude API (Sonnet via `claude -p` subprocess), Python 3.11 with `python-garminconnect`, Concept2 Logbook OAuth REST, Discord.js, systemd.

**Source design:** `/Users/maxwellcollins/Developer/habit-daemon/docs/plans/2026-05-12-habit-daemon-design.md` — Sections 1–6 are the contract. This plan is the build sequencing for Phase A only. Phases B and C have their own plans, drafted after Phase A retro.

**Universal TDD cycle (applies to every task):**
1. Write the failing test
2. Run test, verify it fails for the expected reason
3. Implement the minimal code to pass
4. Run test, verify it passes
5. Run `pnpm typecheck` — must pass
6. Run `pnpm test` — full suite must pass
7. Commit with conventional-commit message

**Universal commit footer:** None. (Attribution disabled globally per user config.)

**File naming convention:** `src/{db,lib,orchestrate,domain}/<kebab-case>.ts`. Tests parallel: `tests/{db,lib,orchestrate,domain}/<kebab-case>.test.ts`.

---

## Tier 1 — Foundation

### Task 1: Initialize Node.js project + TypeScript + Vitest

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.nvmrc` (content: `20`)
- Create: `tests/smoke.test.ts`

**Step 1: Write the failing test**

```ts
// tests/smoke.test.ts
import { describe, it, expect } from "vitest";
describe("smoke", () => {
  it("typescript compiles and vitest runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

**Step 2: Run test to verify it fails**
`pnpm test` — Expected: fails because pnpm/vitest not yet installed.

**Step 3: Write minimal implementation**

`package.json`:
```json
{
  "name": "habit-daemon",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "gate": "pnpm typecheck && pnpm build && pnpm test"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

`tsconfig.json`: strict, ES2022 target, module=NodeNext, moduleResolution=NodeNext, outDir=dist, rootDir=src.

`vitest.config.ts`: default config, test paths under `tests/`.

`.gitignore`: `node_modules/`, `dist/`, `habit-state.db*`, `.env`, `~/.habit-daemon/`, `.DS_Store`, `*.log`.

**Step 4: Verify test passes**
`pnpm install && pnpm test` — Expected: 1 passed.

**Step 5: Commit**
```
feat(scaffold): initialize Node + TypeScript + Vitest
```

---

### Task 2: Initialize SQLite + better-sqlite3 + migration runner

**Files:**
- Create: `src/db/connection.ts`
- Create: `src/db/migrate.ts`
- Create: `src/db/migrations/` (empty dir, gitkeep)
- Create: `tests/db/migration-runner.test.ts`

**Step 1: Write the failing test**

```ts
// tests/db/migration-runner.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";

describe("migration runner", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); });

  it("creates _migrations table on first run", async () => {
    await runMigrations(db, []);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'").get();
    expect(row).toBeDefined();
  });

  it("applies migrations in order and records them", async () => {
    await runMigrations(db, [
      { id: "001_test", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY)" },
    ]);
    const foo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo'").get();
    expect(foo).toBeDefined();
    const record = db.prepare("SELECT id FROM _migrations WHERE id='001_test'").get();
    expect(record).toBeDefined();
  });

  it("does not re-apply migrations", async () => {
    const migration = { id: "001_test", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY)" };
    await runMigrations(db, [migration]);
    // Second run must not throw "table foo already exists"
    await expect(runMigrations(db, [migration])).resolves.not.toThrow();
  });
});
```

**Step 2: Run test, verify failure** — module not found.

**Step 3: Implement**

`src/db/connection.ts` — exports `openDatabase(path: string): Database.Database` wrapping better-sqlite3 with WAL mode + foreign_keys=ON.

`src/db/migrate.ts` — exports `runMigrations(db, migrations: {id, up}[]): Promise<void>` that creates `_migrations(id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)` if missing, then applies any migration whose id is not yet in the table, each in a transaction.

Install: `pnpm add better-sqlite3 && pnpm add -D @types/better-sqlite3`.

**Step 4: Verify test passes** — 3 passed.

**Step 5: Commit**
```
feat(db): sqlite connection + migration runner with _migrations table
```

---

## Tier 2 — Fork PLW daemon

### Task 3: Copy forked PLW daemon files

**Files (all created in this repo, sourced from `/Users/maxwellcollins/Developer/Property-Linkware-v2.1/scripts/`):**
- Create: `src/daemon/scheduler-daemon.ts`
- Create: `src/daemon/scheduler.ts`
- Create: `src/daemon/cron-parser.ts`
- Create: `src/daemon/sdk-dispatch.ts`
- Create: `src/daemon/session-store.ts`
- Create: `src/daemon/ledger.ts`
- Create: `src/daemon/kill-switch.ts`
- Create: `src/daemon/verify-footer.ts`
- Create: `src/daemon/heartbeat.ts`
- Create: `src/daemon/aat-chain.ts`
- Create: `LICENSE-FORKED-FROM-PLW.md` (provenance note)

**Step 1: Write the failing test**

```ts
// tests/daemon/fork-import.test.ts
import { describe, it, expect } from "vitest";
import { schedulerTick } from "../../src/daemon/scheduler.js";
import { dispatchClaude } from "../../src/daemon/sdk-dispatch.js";
import { SessionStore } from "../../src/daemon/session-store.js";

describe("forked daemon modules", () => {
  it("imports without error", () => {
    expect(schedulerTick).toBeDefined();
    expect(dispatchClaude).toBeDefined();
    expect(SessionStore).toBeDefined();
  });
});
```

**Step 2: Run, verify failure** — files don't exist.

**Step 3: Implement**
- Read each PLW file in turn and copy contents to the new path
- Adapt imports: any reference to PLW-specific paths (`../lib/orchestrator/...`) becomes relative to `src/daemon/`
- Add header comment to each file:
  ```ts
  /**
   * Forked from Property-Linkware-v2.1/scripts/<original-path> at PLW commit v1.
   * Diverges from this point. Do not auto-sync.
   */
  ```
- `LICENSE-FORKED-FROM-PLW.md` documents the fork provenance, the commit hash, the date, and the agreed divergence policy

**Step 4: Verify test passes + typecheck clean**

**Step 5: Commit**
```
feat(daemon): fork scheduler/dispatch/session-store/ledger from PLW v1
```

---

### Task 4: Smoke test — forked daemon starts and ticks

**Files:**
- Create: `tests/daemon/scheduler-smoke.test.ts`
- Modify: `src/daemon/scheduler-daemon.ts` — export `loop` for testability

**Step 1: Write failing test**

```ts
// tests/daemon/scheduler-smoke.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { schedulerTick } from "../../src/daemon/scheduler.js";

describe("scheduler tick", () => {
  it("runs against empty schedules table without error", async () => {
    const db = new Database(":memory:");
    // schedules table shape == PLW's (from src/daemon/ledger.ts
    // applyLedgerSchema) + dispatch_priority column added by migration 003.
    // Reconciled with production reality 2026-05-12: see commit history.
    db.exec(`CREATE TABLE schedules (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      cron_expr         TEXT NOT NULL,
      verb              TEXT NOT NULL,
      args_json         TEXT NOT NULL,
      missed_run_policy TEXT NOT NULL DEFAULT 'skip',
      enabled           INTEGER NOT NULL DEFAULT 1,
      last_run_iso      TEXT,
      next_run_iso      TEXT,
      dispatch_priority INTEGER NOT NULL DEFAULT 100
    );`);
    await expect(schedulerTick({ db, dispatch: async () => {} })).resolves.not.toThrow();
  });
});
```

**Step 2-5:** Standard TDD cycle. May require minor adapter shims for the PLW scheduler signature (the PLW version takes a ledger object; refactor minimal to accept a `dispatch` callback for testability — document in commit).

Commit: `test(daemon): smoke test scheduler tick on empty schedule`

---

## Tier 3 — Schema

### Task 5: Migration 001 — core habit tables

**Files:**
- Create: `src/db/migrations/001_habits.sql`
- Create: `src/db/load-migrations.ts` (reads `migrations/*.sql` from disk)
- Create: `tests/db/migration-001.test.ts`

**Step 1: Test asserts:** tables exist (`habits`, `habit_runs`, `proof_stages`), all columns/constraints present, foreign keys enforced, unique constraint on `(habit_id, fire_date)` for `habit_runs`.

**Step 3: Implement** — Migration content is the SQL from the design doc §2 for the three tables. `load-migrations.ts` reads `.sql` files from disk, returns `{id, up}[]` sorted by filename.

**Commit:** `feat(db): migration 001 — habits, habit_runs, proof_stages`

---

### Task 6: Migration 002 — miss_reasons, sensor_signals, plan_changes

**Files:**
- Create: `src/db/migrations/002_intel_and_sensors.sql`
- Create: `tests/db/migration-002.test.ts`

**Test asserts:** all three tables exist with columns from design doc §2. Foreign keys enforced.

**Commit:** `feat(db): migration 002 — miss_reasons, sensor_signals, plan_changes`

---

### Task 7: Migration 003 — extend schedules + session_events

**Files:**
- Create: `src/db/migrations/003_schedules_priority_and_events.sql`
- Create: `tests/db/migration-003.test.ts`

**Migration content:**
```sql
-- Add dispatch_priority to schedules (default 100)
ALTER TABLE schedules ADD COLUMN dispatch_priority INTEGER NOT NULL DEFAULT 100;

-- session_events is created by the PLW fork; this migration ensures it exists
-- (CREATE TABLE IF NOT EXISTS) and extends the allowed event_type values via
-- a CHECK constraint update (drop+recreate if necessary).
```

**Test asserts:** `dispatch_priority` column exists with default 100. `session_events` accepts the new habit-specific event_type strings.

**Commit:** `feat(db): migration 003 — schedules.dispatch_priority + habit event types`

---

## Tier 4 — Seed habits

### Task 8: Seed three habits with full why_stakes_json

**Files:**
- Create: `src/db/seed-habits.ts`
- Create: `tests/db/seed-habits.test.ts`

**Seed contents:** From design doc §2 — three rows for `morning-row`, `strength-mwf`, `wind-down` with the user's locked `why_stakes_json` (stakes_well primary/secondary/tertiary verbatim, body_data_well signal_mode per habit, pattern_well structure populated).

**Test asserts:** seed inserts three rows; re-running is idempotent (uses INSERT OR REPLACE keyed on `id`); `why_stakes_json` parses to a valid object with required keys.

**Commit:** `feat(db): seed three habits with locked why_stakes`

---

## Tier 5 — Sensor adapters

### Task 9: Concept2 OAuth setup CLI

**Files:**
- Create: `src/lib/concept2-adapter.ts` (auth-flow exports only at this task)
- Create: `bin/concept2-auth.ts` (CLI command for one-time auth)
- Create: `tests/lib/concept2-auth.test.ts`

**Behavior:** `concept2-auth` reads `~/.habit-daemon/concept2-credentials.json` (CLIENT_ID + CLIENT_SECRET), prints the OAuth authorization URL, accepts the callback code on stdin, exchanges it for `{access_token, refresh_token, expires_at}`, writes to `~/.habit-daemon/concept2-tokens.json`.

**Test:** mock the token exchange endpoint, verify tokens file written with correct shape.

**Commit:** `feat(concept2): one-time OAuth setup CLI`

---

### Task 10: Concept2 results fetch with auto-refresh

**Files:**
- Modify: `src/lib/concept2-adapter.ts` — add `fetchRowsBetween(from: Date, to: Date)`
- Create: `tests/lib/concept2-fetch.test.ts`

**Behavior:** authenticated GET to `/api/users/me/results?from=<iso>&to=<iso>`. On 401, refreshes token using `refresh_token`, retries once. Pagination handled (follows `links.next` if present, though default page=50 makes single page sufficient for ≤1-day windows).

**Test:** mock 200 response, mock 401-then-200 with refresh, mock paginated response.

**Commit:** `feat(concept2): authenticated results fetch with auto-refresh`

---

### Task 11: Concept2 cache to sensor_signals

**Files:**
- Modify: `src/lib/concept2-adapter.ts` — add `syncDate(db, date)` that fetches + writes to `sensor_signals`
- Create: `tests/lib/concept2-sync.test.ts`

**Test asserts:** for a given date, the adapter pulls sessions, upserts a `sensor_signals` row with `source='concept2'`, `payload_date=YYYY-MM-DD`, `payload_json` containing the session list.

**Commit:** `feat(concept2): cache daily results to sensor_signals`

---

### Task 12: Python garmin shim

**Files:**
- Create: `scripts/garmin_fetch.py`
- Create: `scripts/requirements.txt` (just `garminconnect>=0.2.0`)
- Create: `tests/lib/garmin-shim.test.ts`

**Python script:**
- `--login` mode: prompts for email + password + MFA, seeds `~/.garminconnect/` token cache, exits 0.
- `--date YYYY-MM-DD --fields sleep_onset_time,total_sleep_minutes,rem_minutes,deep_sleep_minutes,hrv` mode: reads cached tokens, calls `client.get_sleep_data(date)`, extracts requested fields, prints JSON to stdout, exits 0.
- On auth-token-expired: exits 2 with stderr message; on network failure: exits 3; on no-data-for-date: exits 0 with `{}`.

**Test (TS side):** runs the Python script with `--date` against a stub mode (flag `--stub` returns canned JSON) to verify the Node-side parses correctly.

**Commit:** `feat(garmin): python shim using python-garminconnect`

---

### Task 13: Garmin Node bridge

**Files:**
- Create: `src/lib/garmin-adapter.ts`
- Create: `tests/lib/garmin-adapter.test.ts`

**Behavior:** `fetchSleep(date: string): Promise<GarminSleep | null>` spawns `python scripts/garmin_fetch.py --date <iso> --fields <list>`. Reads stdout JSON. Maps exit codes to typed results: 0 → data or `null` for empty, 2 → throws `GarminAuthExpired`, 3 → throws `GarminNetworkError`.

**Test:** uses `--stub` flag on the Python script to return canned data; verifies Node parses each exit-code path correctly.

**Commit:** `feat(garmin): Node bridge to python shim via spawnSync`

---

### Task 14: Garmin cache to sensor_signals

**Files:**
- Modify: `src/lib/garmin-adapter.ts` — add `syncDate(db, date)`
- Create: `tests/lib/garmin-sync.test.ts`

**Test asserts:** upserts `sensor_signals` row with `source='garmin'`, payload contains the requested fields.

**Commit:** `feat(garmin): cache daily sleep to sensor_signals`

---

### Task 15: Sensor failure handling — unresolved status path

**Files:**
- Create: `src/orchestrate/resolve-sensor-failure.ts`
- Create: `tests/orchestrate/sensor-failure.test.ts`

**Behavior:** when a habit run requires sensor data and the sensor fetch throws `Garmin*Error` or Concept2 fails after refresh: `habit_runs.status` transitions to `unresolved`, `next_escalation_at` halts, an event `sensor_failure_logged` is written to `session_events`.

**Test:** mock the sensor adapter throwing; assert status transitions; assert event logged.

**Commit:** `feat(orchestrate): unresolved status path for sensor failures`

---

### Task 16: retry-unresolved-sensors verb + cron

**Files:**
- Create: `src/orchestrate/retry-unresolved-sensors.ts`
- Create: `tests/orchestrate/retry-unresolved-sensors.test.ts`

**Behavior:** verb queries `SELECT * FROM habit_runs WHERE status='unresolved'`. For each, re-attempts sensor pull. On success, resolves to `completed`/`missed` per habit's proof_config. After 48h of failed retries (compare `fired_at`), terminal transition to `unresolved_no_data` excluded from compliance math.

**Cron registration:** `INSERT INTO schedules` row for `0 */6 * * *` calling `retry-unresolved-sensors` verb with dispatch_priority=50.

**Test:** seed an unresolved run, mock sensor returning data on retry, assert resolution. Seed a 49h-old unresolved run, assert transitions to `unresolved_no_data`.

**Commit:** `feat(orchestrate): retry-unresolved-sensors verb + 6h cron`

---

## Tier 6 — Vision verification

### Task 17: VISION_REGISTRY definitions

**Files:**
- Create: `src/lib/vision-registry.ts`
- Create: `tests/lib/vision-registry.test.ts`

**Registry entries (verbatim from design doc §4):** `pm5_screen`, `training_log`. Each with `prompt`, `schema`, and `thresholds` (e.g., pm5 requires `duration_minutes >= 10 AND completed === true`).

**Test:** registry has both entries, schemas validate, thresholds match design doc.

**Commit:** `feat(vision): registry with pm5_screen + training_log entries`

---

### Task 18: vision-verify.ts Claude wrapper

**Files:**
- Create: `src/lib/vision-verify.ts`
- Create: `tests/lib/vision-verify.test.ts`

**Behavior:** `verifyImage(imageUrl, subject): Promise<{passed, parsed, reason?}>` calls `claude -p` via `sdk-dispatch` with the registry's prompt + JSON schema. Parses structured output. Applies registry's thresholds. Returns pass/fail with the parsed payload.

**Test:** mock `dispatchClaude` to return canned structured outputs; assert pass when thresholds met, fail when not, fail with reason on schema validation error.

**Commit:** `feat(vision): verifyImage wrapper over claude -p with thresholds`

---

### Task 19: Vision rejection counter (writes flag, no Discord coupling)

**Files:**
- Create: `src/orchestrate/vision-rejection-counter.ts`
- Create: `tests/orchestrate/vision-rejection-counter.test.ts`

**Architectural note:** Vision-verify must stay decoupled from discord-adapter (testable in CLI, web-admin, future v2 contexts). Vision rejection writes a flag on the habit_runs row; the next habit-checkin invocation reads the flag and includes the callout text in its prompt; the flag is reset after that dispatch. The callout fires on the next L+1 message anyway (rejections don't move `next_escalation_at`), so piggybacking on the already-scheduled dispatch is the natural moment.

**Behavior:**
1. On each `verifyImage` rejection in an active run, write a `proof_attempt_rejected` event to `session_events`.
2. `next_escalation_at` UNCHANGED.
3. Counter check: `SELECT COUNT(*) FROM session_events WHERE run_id=? AND event_type='proof_attempt_rejected'`.
4. If count ≥ 3, `UPDATE habit_runs SET proof_rejection_callout_due = 1 WHERE id=?`.
5. No Discord dispatch from this task. The callout text is composed inside the next habit-checkin prompt builder (Task 24+) when it sees the flag set, and habit-checkin resets the flag after a successful dispatch.

**Test:**
- Seed 2 prior rejection events, simulate 3rd → assert `proof_rejection_callout_due=1` set on habit_runs row.
- Assert `next_escalation_at` not modified.
- Assert no Discord adapter calls (the test should not require discord-adapter to be importable).
- Seed run with 5 rejections but flag already true → assert no duplicate work (idempotent).

**Commit:** `feat(orchestrate): vision rejection counter sets habit_runs flag (3+ threshold)`

---

## Tier 7 — Discord adapter

### Task 20: Discord client + token + channel registry

**Files:**
- Create: `src/lib/discord-adapter.ts` (client init + channel registry only)
- Create: `tests/lib/discord-adapter-init.test.ts`

**Behavior:** reads `DISCORD_BOT_TOKEN` from env, instantiates `discord.js` `Client` with `Guilds + GuildMessages + MessageContent` intents. Maintains a typed `CHANNELS` registry mapping `'morning-row' | 'strength' | 'wind-down' | 'wins' | 'sunday-review'` → channel ID (env-configured).

**Test:** mocks the discord.js client; asserts construction with correct intents, asserts channel registry validates env config (throws if any channel ID missing).

Install: `pnpm add discord.js`.

**Commit:** `feat(discord): client init + channel registry`

---

### Task 21: Discord webhook poster (outgoing)

**Files:**
- Modify: `src/lib/discord-adapter.ts` — add `postToChannel(name, content, attachments?)`
- Create: `tests/lib/discord-post.test.ts`

**Behavior:** resolves channel by name from registry, sends message via discord.js `channel.send({content, files})`. Returns `{messageId, channelId, postedAt}`.

**Test:** mock the channel.send method; assert call with correct content + files; assert returned object shape.

**Commit:** `feat(discord): postToChannel webhook poster`

---

### Task 22: Discord listener (incoming + active run match)

**Files:**
- Modify: `src/lib/discord-adapter.ts` — add `subscribeMessages(handler)`
- Create: `tests/lib/discord-listener.test.ts`

**Behavior:** subscribes to `MessageCreate` on the 3 active channels. For each incoming message: look up active `habit_runs` row by `channel_id` + `author_id` (compared against habit's expected user) + `status IN ('pending', 'partial')` within today's fire window. Returns `{run, message}` to handler or no-op if no active run.

**Test:** mock channel.on; seed habit_runs rows; emit synthetic MessageCreate events; assert handler called with correct {run, message} mappings.

**Commit:** `feat(discord): incoming message listener with active run matching`

---

### Task 23: #wins channel auto-post on completion

**Files:**
- Create: `src/orchestrate/wins-poster.ts`
- Create: `tests/orchestrate/wins-poster.test.ts`

**Behavior:** invoked when a `habit_runs.status` transitions to `completed`. Formats a one-line factual record per habit type (no qualifiers):
- row: `✓ Morning row · 9:42 · 12 min · 2,143m`
- strength: `✓ Strength · Wed 7:08pm · 4 lifts logged`
- wind-down: `✓ Wind-down · stage A 22:08 · Garmin asleep 22:55`

Posts to `#wins` via `discord-adapter.postToChannel`.

**Test:** assert formatter output exact strings for canned input. Assert it does NOT post for `missed`/`skipped`/`unresolved` transitions.

**Commit:** `feat(orchestrate): wins-poster on completion, bare-facts format`

---

## Tier 8 — habit-checkin core

### Task 24: habit-checkin verb scaffold + L1 message + shared prompt-builder

**Files:**
- Create: `src/orchestrate/habit-checkin.ts`
- Create: `src/lib/prompt-builder.ts`  ← shared helper used by all level templates
- Create: `src/lib/prompt-templates/level-1.ts`
- Create: `tests/orchestrate/habit-checkin-l1.test.ts`
- Create: `tests/lib/prompt-builder.test.ts`

**Behavior:** verb invoked by scheduler with `{run_id, current_level: 1}`. Loads habit + run + recent events. Builds a Claude system prompt that includes habit name, time, proof_type, and the warm-friend voice rules. Dispatches `claude -p` with `--json-schema` requiring `{message_text, next_check_in_iso}`. Posts message to habit's channel. Updates `next_escalation_at` per habit's L1→L2 delta.

**Shared prompt-builder responsibilities (used by Tasks 24, 25, 27, 28, 30, 31):**
- Composes the system prompt from: voice rules for the level, habit context, run context, recent events.
- **Reads `habit_runs.proof_rejection_callout_due`. If `true`, prepends to the prompt:** "The user has had 3+ photo proof attempts rejected this run. Call this out directly in your message: 'That's three photos that aren't the {proof_config.vision_subject}. What's going on?' Compose this naturally into the level's tone — at L1 it stays warm-friend ('Hey — three photos that weren't the {subject}, what's going on?'); at L4 it's direct."
- **After habit-checkin successfully dispatches a message with the callout, `UPDATE habit_runs SET proof_rejection_callout_due = 0 WHERE id=?`.**
- This means the callout fires exactly once per "third strike" — not on every subsequent message.

**Test (Task 24):** mock `dispatchClaude` to return canned output. Assert: structured output parsed, message posted to correct channel, `next_escalation_at` advanced by correct delta per habit (row +30m, wind-down +8m).

**Test (prompt-builder):**
- Without flag → prompt does not contain callout instruction.
- With flag → prompt contains callout instruction, vision_subject interpolated correctly.
- After dispatch → flag reset to 0 in DB.
- Idempotent: same run, same level, fired twice (e.g., retry) — second fire does not re-include callout because flag is now 0.

**Commit:** `feat(orchestrate): habit-checkin verb with L1 message + shared prompt-builder reading rejection callout flag`

---

### Task 25: L2 curious check-in (no why)

**Files:**
- Create: `src/lib/prompt-templates/level-2.ts`
- Modify: `src/orchestrate/habit-checkin.ts` — handle current_level=2
- Create: `tests/orchestrate/habit-checkin-l2.test.ts`

**Behavior:** at L2, prompt includes the curious-not-loaded voice rule. NO WHY content. Example expected output: "Hey, no row yet? What's going on?"

**Test:** mock dispatch, assert prompt instructs no-why-yet, assert output message follows the curious shape (no spine/Linkware references).

**Commit:** `feat(orchestrate): L2 curious check-in template`

---

### Task 26: L3 WHY-well selection orchestration

**Files:**
- Create: `src/lib/why-well-selector.ts`
- Create: `tests/lib/why-well-selector.test.ts`

**Behavior:** pure function `selectWell(habit, run, missReasons30d, sensorSignals, lastPatternUse): {well: 'pattern'|'body_data'|'stakes', payload}`. Implements design doc §3 priority:
1. pattern_well if `pattern_detector(28d).count >= 3 AND last_pattern_well_use < now() - 14d`
2. body_data_well if `body_data_anomaly_detected()`
3. stakes_well (rotation primary→secondary→tertiary, 7-day dedup against last_stakes_well_used)

**Test:** comprehensive matrix covering all three branches + cooldown + rotation. ≥10 test cases.

**Commit:** `feat(orchestrate): WHY-well selector with pattern>body>stakes priority`

---

### Task 27: L3 stakes_well rotation

**Files:**
- Modify: `src/lib/why-well-selector.ts` — implement stakes rotation
- Create: `src/lib/prompt-templates/level-3-stakes.ts`
- Modify: `src/orchestrate/habit-checkin.ts` — wire L3 to selector
- Create: `tests/orchestrate/habit-checkin-l3-stakes.test.ts`

**Test:** seed history showing stakes_well used 7+ days ago with `primary` → selector returns `secondary` next. Used same day → returns same. Used 6 days ago → returns same (dedup window is 7 days).

**Commit:** `feat(orchestrate): L3 stakes_well rotation with 7d dedup`

---

### Task 28: L3 body_data_well anomaly detection

**Files:**
- Create: `src/lib/anomaly-detector.ts`
- Modify: `src/lib/prompt-templates/level-3-body-data.ts`
- Create: `tests/lib/anomaly-detector.test.ts`

**Behavior:** per-habit anomaly check from `signal_mode`. For `prior_night` mode (row, strength): pull last night's sensor_signal, check if any `relevant_signals` field is in bottom 20% of trailing 30-day baseline. For `trailing_week_trend` mode (wind-down): compute 7-day rolling averages, compare to 30-day baseline, flag if delta exceeds threshold (30 min for sleep_onset).

**Test:** seed 30 days of synthetic sensor data, seed a prior-night value in bottom 20%, assert anomaly fires. Seed a non-anomalous night, assert no anomaly.

**Commit:** `feat(orchestrate): L3 body_data_well anomaly detection per signal_mode`

---

### Task 29: L3 pattern_well dormant no-op

**Files:**
- Create: `src/lib/pattern-detector.ts`
- Modify: `src/lib/why-well-selector.ts` — call pattern detector first per priority
- Create: `tests/lib/pattern-detector.test.ts`

**Behavior:** pattern detector queries `miss_reasons` table for slug-prefix groupings over 28 days. Returns `{groups: Array<{slug_prefix, count, exemplar_specifics}>, threshold_met: boolean}`. In Phase A, the table will be empty/sparse — detector must return `threshold_met: false` cleanly without errors. Phase B activates the rest of the logic.

**Test:** empty `miss_reasons` table → returns `threshold_met: false`. Single-entry table → returns `threshold_met: false`. (Full activation tested in Phase B.)

**Commit:** `feat(orchestrate): pattern_well detector with dormant no-op on insufficient data`

---

### Task 30: L4 direct callout (no new why)

**Files:**
- Create: `src/lib/prompt-templates/level-4.ts`
- Modify: `src/orchestrate/habit-checkin.ts` — handle current_level=4
- Create: `tests/orchestrate/habit-checkin-l4.test.ts`

**Behavior:** L4 explicit prompt: "Direct callout only. No new WHY content. The why was deployed at L3. Examples: 'Max. 90 minutes past. What's actually blocking you right now?'"

**Test:** assert prompt instructs no-why-content, assert generated message stays in tonal-only space.

**Commit:** `feat(orchestrate): L4 direct callout template`

---

### Task 31: L5 final message + status='missed' transition

**Files:**
- Create: `src/lib/prompt-templates/level-5.ts`
- Modify: `src/orchestrate/habit-checkin.ts` — handle current_level=5; on completion of L5 dispatch, update `status='missed'`, null `next_escalation_at`
- Create: `tests/orchestrate/habit-checkin-l5.test.ts`

**Behavior:** L5 message is final — "Logged as missed. We'll talk tomorrow." Variation per habit. After posting, runs the transition.

**Test:** assert message posted, assert DB state has `status='missed'`, `next_escalation_at IS NULL`.

**Commit:** `feat(orchestrate): L5 final message + missed status transition`

---

### Task 32: next_escalation_at polling tick in scheduler

**Files:**
- Modify: `src/daemon/scheduler.ts` — add polling for habit_runs
- Create: `tests/daemon/escalation-polling.test.ts`

**Behavior:** scheduler tick adds a SELECT against habit_runs: `WHERE next_escalation_at <= now AND status='pending'`. For each, dispatches `habit-checkin` verb. After dispatch, scheduler does NOT increment level — habit-checkin owns level/next_escalation_at update. Scheduler only fires.

**Test:** seed runs at various levels, simulate tick at time T, assert correct runs dispatched in priority order (lower `dispatch_priority` first, then by `fired_at`).

**Commit:** `feat(daemon): scheduler polls habit_runs.next_escalation_at`

---

## Tier 9 — Proof verification

### Task 33: verify-proof verb scaffold + routing

**Files:**
- Create: `src/orchestrate/verify-proof.ts`
- Create: `tests/orchestrate/verify-proof-routing.test.ts`

**Behavior:** verb invoked by discord listener when user posts a message with attachment in a habit channel during an active run. Reads habit's `proof_type`, routes to the correct sub-verb:
- `concept2_api+photo_fallback` → `verifyConcept2OrPhoto`
- `training_log_photo` → `verifyTrainingLogPhoto`
- `typed_msg+garmin_sleep` → `verifyWindDownStageA`

**Test:** mock the sub-verbs, assert routing per habit's proof_type.

**Commit:** `feat(orchestrate): verify-proof routing per habit proof_type`

---

### Task 34: verify-proof Concept2 path

**Files:**
- Modify: `src/orchestrate/verify-proof.ts` — add `verifyConcept2OrPhoto`
- Create: `tests/orchestrate/verify-proof-concept2.test.ts`

**Behavior:** first attempts Concept2 API check via `concept2-adapter.syncDate` + filter by morning window + duration >= 10 min. If found: `status='completed'`, post to #wins. If not found AND level >= `fallback_required_at_level` (3): falls through to vision verification of attached photo via `verifyImage(imageUrl, 'pm5_screen')`.

**Test:** mock Concept2 returning a valid row → completion. Mock empty Concept2 + valid PM5 photo at L3+ → completion via vision. Mock empty Concept2 + non-PM5 photo → rejection.

**Commit:** `feat(orchestrate): verify-proof Concept2 with photo fallback`

---

### Task 35: verify-proof vision path

**Files:**
- Modify: `src/orchestrate/verify-proof.ts` — add `verifyTrainingLogPhoto`
- Create: `tests/orchestrate/verify-proof-training-log.test.ts`

**Behavior:** invokes `verifyImage(imageUrl, 'training_log')`. Pass → completion. Fail → rejection event + counter check (via Task 19 vision-rejection-counter).

**Test:** mock verifyImage pass → completion. Mock fail → rejection counter logic.

**Commit:** `feat(orchestrate): verify-proof training-log via vision`

---

### Task 36: verify-proof wind-down two-stage

**Files:**
- Modify: `src/orchestrate/verify-proof.ts` — add `verifyWindDownStageA`
- Create: `tests/orchestrate/verify-proof-wind-down.test.ts`

**Behavior:** on incoming text containing "shutting down" (case-insensitive, fuzzy match against `stage_a_phrase`): write `proof_stages` row with `stage='a'`, `satisfied=true`. Transition `habit_runs.status` to `partial`. Post ack: "Got it. Garmin will tell us the rest." Halt escalation (`next_escalation_at=NULL`).

**Test:** simulate "shutting down" within 10:00-10:15 window → partial. Outside window → no-op. After 10:15 → wind-down already at level 4+, message logged but stage_a remains unsatisfied.

**Commit:** `feat(orchestrate): verify-proof wind-down stage A`

---

### Task 37: evaluate-stage-b verb (cron 0 9 * * *)

**Files:**
- Create: `src/orchestrate/evaluate-stage-b.ts`
- Create: `tests/orchestrate/evaluate-stage-b.test.ts`

**Behavior:** verb queries `habit_runs WHERE habit_id='wind-down' AND status='partial' AND fire_date=yesterday()`. For each, pulls `sensor_signals` for last night's Garmin sleep_onset_time. If `sleep_onset_time <= stage_b_threshold (23:00)`: write `proof_stages` row `stage='b' satisfied=true`, transition to `completed`, post to #wins. Else: transition to `missed`, write `gap_metadata_json` to `miss_reasons`, post curious follow-up to #wind-down.

**Cron registration:** INSERT into `schedules` with cron `0 9 * * *`, verb `evaluate-stage-b`, `dispatch_priority=10`.

**Test:** seed partial run + canned Garmin signal. Assert resolution per threshold. Assert correct `miss_reasons` row on fail with gap_minutes correct.

**Commit:** `feat(orchestrate): evaluate-stage-b verb + 9am cron`

---

### Task 38: Stage-B priority enforcement + defensive guard

**Files:**
- Modify: `src/orchestrate/habit-checkin.ts` — add defensive guard for `morning-row` L1
- Create: `tests/orchestrate/habit-checkin-defensive-guard.test.ts`

**Behavior:** when habit-checkin is invoked for `morning-row` at L1, before generating message: `SELECT 1 FROM habit_runs WHERE habit_id='wind-down' AND status='partial' AND fire_date=yesterday() LIMIT 1`. If found, defer by 60s (update `next_escalation_at` to now+60s, return without dispatching). Belt + suspenders with the dispatch_priority sort.

**Test:** seed wind-down partial run → assert row L1 deferred. Seed no partial run → assert row L1 fires.

**Commit:** `feat(orchestrate): morning-row defensive guard for partial wind-down`

---

## Tier 10 — Runtime + soak

### Task 39: systemd unit file + install script

**Files:**
- Create: `deploy/habit-daemon.service`
- Create: `deploy/install.sh`
- Create: `tests/deploy/unit-file.test.ts`

**Unit file:**
```ini
[Unit]
Description=habit-daemon
After=network-online.target

[Service]
Type=notify
ExecStart=/usr/bin/node /opt/habit-daemon/dist/daemon/scheduler-daemon.js
WorkingDirectory=/opt/habit-daemon
Restart=on-failure
RestartSec=10
WatchdogSec=120
NotifyAccess=all
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**Install script:** copies built `dist/` to `/opt/habit-daemon`, copies unit file to `/etc/systemd/system/`, runs `systemctl daemon-reload && systemctl enable habit-daemon && systemctl start habit-daemon`. Validates `systemctl status habit-daemon` shows `active (running)`.

**Test:** lints the unit file structure, asserts install.sh runs without error against a mock systemctl.

**Commit:** `feat(deploy): systemd unit + install script`

---

### Task 40: Phase A soak smoke tests

**Files:**
- Create: `tests/soak/phase-a-smoke.test.ts`

**Smoke set covers:**
- Daemon starts via `node dist/daemon/scheduler-daemon.js`, watchdog notification observable
- Scheduler tick fires a test prompt (mock schedule row) and dispatches mock claude
- Vision verification rejection path triggers proper event + counter
- Sensor stub returns expected shape (Concept2 + Garmin)
- Stage-B evaluator processes a seeded partial run

**Commit:** `test(soak): Phase A smoke gate suite`

---

### Task 41: Phase A L3 manual-trigger test scenarios (falsifiability)

**Files:**
- Create: `tests/soak/phase-a-l3-manual-trigger.test.ts`
- Create: `bin/simulate-miss.ts` — CLI to inject a synthetic L3 fire per habit

**Behavior:** the design's L3-falsifiability addition. If no L3 fires occur organically during soak (high-compliance week), end-of-phase test invokes `simulate-miss --habit=<id>` for each habit. The CLI: artificially advances time, fires the next escalation level, captures the message + selected well. Test asserts each habit's L3 dispatched, well selected per priority, message generated.

**Commit:** `test(soak): L3 manual-trigger CLI + falsifiability test`

---

### Task 42: Phase A retro template

**Files:**
- Create: `docs/retros/phase-A-retro-template.md`

**Template structure (filled in at end of Phase A soak):**
```markdown
# Phase A Retro

**Soak window:** YYYY-MM-DD to YYYY-MM-DD

## Worked
- ...

## Failed
- ...

## Surprised
- ...

## Changes to subsequent phase specs
- Phase B: [adjustments]
- Phase C: [adjustments]
```

**Commit:** `docs(retro): Phase A retro template`

---

## Phase A completion gate (must all pass before claiming Phase A done)

- [ ] `pnpm typecheck` clean
- [ ] `pnpm build` clean
- [ ] `pnpm test` — all unit tests green
- [ ] `pnpm test tests/soak/` — all soak tests green
- [ ] systemd unit installed, daemon running, watchdog observable
- [ ] **14-day minimum** real-world soak run with all three habits firing daily. 14 days is a floor, not a ceiling — extend if soak criteria can't yet be observed (e.g., body_data_anomaly hasn't fired organically because compliance is high; in that case extend OR rely on Task 41's manual L3 trigger to satisfy falsifiability). Rationale: wind-down fires 5 nights/week (10 fires in 14 days, doubles statistical power vs 7-day), strength fires 3×/week (6 fires in 14 days), and real-world failure modes like Bluetooth flakes, MFA expiry, and DST-night bugs need room to surface.
- [ ] Soak meets criteria from design doc §6:
  - daemon uptime > 99%
  - all scheduled fires dispatched
  - vision verification accuracy > 95%
  - sensor sync success > 95%
  - stage-B resolution 100% within 24h
  - L3 stakes_well rotation observed (or manually triggered + verified)
  - L3 body_data_well firing observed when sensor anomalies present (or manually triggered + verified)
- [ ] Retro written to `docs/retros/phase-A-retro.md`
- [ ] Phase B plan drafted, reading Phase A retro's "Changes" section

---

## Pre-Phase-A logistics (one-time setup, not part of any task)

These are prerequisites, executed manually before Task 1:

1. Register Discord bot at https://discord.com/developers/applications. Create application, generate bot token. Add bot to private server with `Manage Channels`, `Send Messages`, `Read Message History`, `Embed Links`, `Attach Files`, `Add Reactions` permissions. Capture: `DISCORD_BOT_TOKEN`, channel IDs for `#morning-row`, `#strength`, `#wind-down`, `#wins`, `#sunday-review`.
2. Register Concept2 OAuth client at https://log.concept2.com/developers/keys. Capture `CLIENT_ID` and `CLIENT_SECRET`. Write to `~/.habit-daemon/concept2-credentials.json` (mode 0600).
3. Run `pip install garminconnect` (Python 3.11+).
4. Test Garmin login interactively: `python scripts/garmin_fetch.py --login` (after Task 12) — completes MFA flow, seeds `~/.garminconnect/`.
5. Configure environment via `~/.habit-daemon/env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   DISCORD_BOT_TOKEN=...
   DISCORD_CHANNEL_MORNING_ROW=...
   DISCORD_CHANNEL_STRENGTH=...
   DISCORD_CHANNEL_WIND_DOWN=...
   DISCORD_CHANNEL_WINS=...
   DISCORD_CHANNEL_SUNDAY_REVIEW=...
   ```

These are credentials and one-time setup, not engineering deliverables. They do not appear in any task.

---

## Open questions deferred to Phase A retro (not blockers)

- DST handling — daemon currently assumes single timezone; revisit if user travels.
- Discord bot user vs author matching when DMs are also used — currently channel-only; no DM path in Phase A.
- Backup strategy for `habit-state.db` — assume systemd-level disk snapshots; can formalize in Phase A retro if needed.

---

*End of Phase A implementation plan. 42 tasks. No phase-within-phase. Every Phase A scope item from design doc §6 has at least one corresponding task. Phase B and Phase C have their own plans drafted post-retro.*
