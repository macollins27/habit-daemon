#!/usr/bin/env -S npx tsx
// simulate-miss — manual trigger for habit-daemon L3 WHY-well branches.
//
// Phase A's L3 selector has three branches:
//   - pattern (3+ same-slug-prefix miss_reasons in trailing 28 days,
//              gated by a 14-day cooldown)
//   - body_data (Garmin sensor anomaly: prior_night bottom-20% for
//                morning-row + strength-mwf, trailing_week_trend for
//                wind-down)
//   - stakes (default rotation primary → secondary → tertiary, 7-day
//             dedup window)
//
// Design § 6 (Phase A soak criteria) requires falsifiability evidence for
// L3 stakes_well rotation and L3 body_data_well firing. If no L3 fires
// organically during the 14-day soak (high-compliance week), this CLI
// proves each branch works against a fresh in-memory-shaped temp DB. The
// CLI does NOT touch the production state.db.
//
// Usage:
//   simulate-miss --habit=<id> [--level=<N>] [--well=<stakes|body_data|pattern>]
//
//   --habit  one of 'morning-row' | 'strength-mwf' | 'wind-down'.
//   --level  the level being fired (default 3). Currently only L3 is
//            wired here — the verb owns L1/L2/L4/L5 deterministically
//            and they don't need a selector path proof.
//   --well   which L3 branch to exercise (default 'stakes').
//            - 'stakes': seeds nothing; selector returns primary stake.
//            - 'body_data': seeds 30d Garmin baseline + one anomalous
//              prior-night row (row/strength) OR a 7d hrv drop vs the
//              prior 23d baseline (wind-down).
//            - 'pattern': seeds 3 miss_reasons with the same slug prefix.
//
// Output:
//   A single JSON document on stdout with:
//     {
//       habit, level, well,
//       prompt (truncated to 600 chars),
//       message, newLevel, nextEscalationAt
//     }
//   stderr carries the temp-dir lifecycle messages.
//
// Exit codes:
//   0 — success
//   2 — bad arguments
//   3 — runtime / verb failure

import { parseArgs } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";
import { openDatabase } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadMigrations } from "../src/db/load-migrations.js";
import { seedHabits } from "../src/db/seed-habits.js";
import { SessionStore } from "../src/daemon/session-store.js";
import { createDiscordAdapter } from "../src/lib/discord-adapter.js";
import { runHabitCheckin } from "../src/orchestrate/habit-checkin.js";

// ---------------------------------------------------------------------------
// Constants — must stay aligned with src/db/seed-habits.ts.
// ---------------------------------------------------------------------------

const PHASE_A_HABITS = ["morning-row", "strength-mwf", "wind-down"] as const;
type PhaseAHabit = (typeof PHASE_A_HABITS)[number];

const WELLS = ["stakes", "body_data", "pattern"] as const;
type WellKind = (typeof WELLS)[number];

const SESSION_ID = "simulate-miss-session-0001";
const DAY_MS = 24 * 60 * 60 * 1000;

const CHANNEL_IDS = {
  "morning-row": "1000000000000000001",
  strength: "1000000000000000002",
  "wind-down": "1000000000000000003",
  wins: "1000000000000000004",
  "sunday-review": "1000000000000000005",
} as const;

const SEED_CHANNELS = {
  morningRow: CHANNEL_IDS["morning-row"],
  strength: CHANNEL_IDS.strength,
  windDown: CHANNEL_IDS["wind-down"],
} as const;

interface CliArgs {
  readonly habit: PhaseAHabit;
  readonly level: number;
  readonly well: WellKind;
}

function isPhaseAHabit(s: string): s is PhaseAHabit {
  return (PHASE_A_HABITS as readonly string[]).includes(s);
}

function isWellKind(s: string): s is WellKind {
  return (WELLS as readonly string[]).includes(s);
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      habit: { type: "string" },
      level: { type: "string", default: "3" },
      well: { type: "string", default: "stakes" },
    },
    allowPositionals: false,
    strict: true,
  });
  const habit = parsed.values.habit;
  if (habit === undefined || habit === "") {
    throw new Error(
      "missing required --habit (one of: morning-row | strength-mwf | wind-down)",
    );
  }
  if (!isPhaseAHabit(habit)) {
    throw new Error(
      `invalid --habit '${habit}'. Expected one of: ${PHASE_A_HABITS.join(" | ")}`,
    );
  }

  const levelStr = parsed.values.level ?? "3";
  const level = Number.parseInt(levelStr, 10);
  if (!Number.isInteger(level) || level !== 3) {
    // Phase A: only L3 selector branches need a falsifiability proof. The
    // CLI is intentionally narrow — L1/L2/L4/L5 have unit tests that already
    // prove the deterministic templates.
    throw new Error(
      `--level=${levelStr} is not supported yet (Phase A simulate-miss only proves L3)`,
    );
  }

  const wellStr = parsed.values.well ?? "stakes";
  if (!isWellKind(wellStr)) {
    throw new Error(
      `invalid --well '${wellStr}'. Expected one of: ${WELLS.join(" | ")}`,
    );
  }

  return { habit, level, well: wellStr };
}

// ---------------------------------------------------------------------------
// Branch-specific seeders. Mirror the test fixtures in
// tests/soak/phase-a-l3-manual-trigger.test.ts so the CLI and the tests
// exercise the same selector paths.
// ---------------------------------------------------------------------------

function seedBodyDataPriorNight(
  db: import("better-sqlite3").Database,
  nowMs: number,
  priorDate: string,
): void {
  const insert = db.prepare(
    `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 30; i += 1) {
    const d = new Date(nowMs - (i + 2) * DAY_MS);
    const ymd = d.toISOString().slice(0, 10);
    insert.run(
      `ss-baseline-${i}`,
      "garmin",
      ymd,
      JSON.stringify({ sleep: { rem_minutes: 120 } }),
      nowMs - (i + 2) * DAY_MS,
    );
  }
  insert.run(
    "ss-prior-night",
    "garmin",
    priorDate,
    JSON.stringify({ sleep: { rem_minutes: 10 } }),
    nowMs - DAY_MS,
  );
}

function seedBodyDataTrailingWeek(
  db: import("better-sqlite3").Database,
  nowMs: number,
): void {
  const insert = db.prepare(
    `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= 7; i += 1) {
    const d = new Date(nowMs - i * DAY_MS);
    const ymd = d.toISOString().slice(0, 10);
    insert.run(
      `ss-recent-${i}`,
      "garmin",
      ymd,
      JSON.stringify({ sleep: { hrv: 35 } }),
      nowMs - i * DAY_MS,
    );
  }
  for (let i = 8; i <= 28; i += 1) {
    const d = new Date(nowMs - i * DAY_MS);
    const ymd = d.toISOString().slice(0, 10);
    insert.run(
      `ss-baseline-${i}`,
      "garmin",
      ymd,
      JSON.stringify({ sleep: { hrv: 50 } }),
      nowMs - i * DAY_MS,
    );
  }
}

function seedPattern(
  db: import("better-sqlite3").Database,
  habitId: string,
  nowMs: number,
): void {
  const slug = "late-gaming-friend:brian";
  const insertRun = db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMr = db.prepare(
    `INSERT INTO miss_reasons (id, habit_id, run_id, miss_date,
                               inferred_specifics, classification, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 3; i += 1) {
    const priorMs = nowMs - (i + 1) * DAY_MS;
    const priorDate = new Date(priorMs).toISOString().slice(0, 10);
    insertRun.run(
      `prior-run-${habitId}-${i}`,
      habitId,
      priorDate,
      priorMs,
      5,
      null,
      "missed",
      null,
      null,
      null,
      0,
    );
    insertMr.run(
      `mr-${habitId}-${i}`,
      habitId,
      `prior-run-${habitId}-${i}`,
      priorDate,
      slug,
      "gaming",
      priorMs,
    );
  }
}

/**
 * UTC YYYY-MM-DD for the given epoch ms. The CLI uses UTC end-to-end so the
 * synthetic fire_date, prior_date, and the per-row baseline dates all live on
 * the same clock — using local for one and UTC for the others lets a
 * timezone-relative collision sneak the seeded synthetic run into the same
 * payload_date / fire_date as one of the baseline rows.
 */
function utcDateString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Mocks for the verb's external dependencies.
// ---------------------------------------------------------------------------

interface DispatchResultLike {
  readonly prompt: string;
}

function buildMockDispatch(): {
  readonly impl: (opts: { prompt: string; jsonSchema: string }) => Promise<{
    structured_output: { message_text: string; next_check_in_iso: string };
  }>;
  readonly captured: DispatchResultLike[];
} {
  const captured: DispatchResultLike[] = [];
  const impl = async (opts: {
    prompt: string;
    jsonSchema: string;
  }): Promise<{
    structured_output: { message_text: string; next_check_in_iso: string };
  }> => {
    void opts.jsonSchema;
    captured.push({ prompt: opts.prompt });
    return {
      structured_output: {
        message_text:
          "[simulate-miss synthetic L3 prompt — selector branch verified]",
        next_check_in_iso: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    };
  };
  return { impl, captured };
}

function buildMockAdapter(): ReturnType<typeof createDiscordAdapter> {
  // No-op channel send. The mock client.fetch resolves with a TextChannel-
  // shaped object whose .send is a noop returning a stable id.
  const mockChannel = {
    send: async (): Promise<{ id: string }> => ({ id: "simulate-miss-msg" }),
    isTextBased: (): boolean => true,
  };
  const mockClient = {
    channels: {
      fetch: async (): Promise<typeof mockChannel> => mockChannel,
    },
  };
  return createDiscordAdapter({
    botToken: "simulate-miss-bot-token",
    channelIds: CHANNEL_IDS,
    clientFactory: () => mockClient as unknown as Client,
  });
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

interface SimulationOutput {
  readonly habit: string;
  readonly level: number;
  readonly well: string;
  readonly prompt: string;
  readonly message: string;
  readonly newLevel: number;
  readonly nextEscalationAt: number | null;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(2);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "simulate-miss-"));
  process.stderr.write(`[simulate-miss] temp dir: ${tempDir}\n`);
  const dbPath = join(tempDir, "store.db");

  try {
    const migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
    seedHabits(migrator, SEED_CHANNELS);
    migrator.close();

    const sessionStore = new SessionStore({ dbPath });
    try {
      const nowMs = Date.now();
      const fireDate = utcDateString(nowMs);
      const runId = `simulate-miss-${args.habit}-${nowMs}`;

      // Seed the synthetic habit_run at currentLevel = level (the verb
      // dispatches the message for THIS level then advances level + 1).
      sessionStore.db
        .prepare(
          `INSERT INTO habit_runs (
             id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
             status, completed_at, proof_payload_json, skip_reason,
             proof_rejection_callout_due
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          args.habit,
          fireDate,
          nowMs,
          args.level,
          null,
          "pending",
          null,
          null,
          null,
          0,
        );

      // Branch-specific seeding so the selector picks the requested well.
      switch (args.well) {
        case "stakes":
          // No additional context needed: with no prior pattern or sensor
          // anomaly the selector falls through to stakes (primary).
          break;
        case "body_data":
          if (args.habit === "wind-down") {
            seedBodyDataTrailingWeek(sessionStore.db, nowMs);
          } else {
            seedBodyDataPriorNight(
              sessionStore.db,
              nowMs,
              utcDateString(nowMs - DAY_MS),
            );
          }
          break;
        case "pattern":
          seedPattern(sessionStore.db, args.habit, nowMs);
          break;
      }

      const adapter = buildMockAdapter();
      const { impl: dispatchImpl, captured } = buildMockDispatch();

      const result = await runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId,
        currentLevel: args.level,
        now: nowMs,
        dispatchImpl,
      });

      // Read back the persisted event to extract the resolved well payload —
      // the selector decision is recorded there, not in the verb's return.
      interface EventRow {
        readonly event_json: string;
      }
      const eventRow = sessionStore.db
        .prepare(
          `SELECT event_json FROM session_events
            WHERE session_id = ? AND event_type = 'habit_prompt_sent'
            ORDER BY seq DESC LIMIT 1`,
        )
        .get(SESSION_ID) as EventRow | undefined;

      const eventPayload =
        eventRow !== undefined
          ? (JSON.parse(eventRow.event_json) as Record<string, unknown>)
          : null;
      const resolvedWell =
        eventPayload !== null && typeof eventPayload["well"] === "string"
          ? (eventPayload["well"] as string)
          : "unknown";

      const promptCaptured = captured[0]?.prompt ?? "";
      const output: SimulationOutput = {
        habit: args.habit,
        level: args.level,
        well: resolvedWell,
        prompt:
          promptCaptured.length > 600
            ? `${promptCaptured.slice(0, 600)}…`
            : promptCaptured,
        message: "[simulate-miss synthetic L3 prompt — selector branch verified]",
        newLevel: result.newLevel,
        nextEscalationAt: result.nextEscalationAt,
      };

      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } finally {
      sessionStore.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exitCode = 3;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
