// Task 36: verifyWindDownStageA sub-verb tests.
//
// The sub-verb is the proof-verification path for `wind-down` whose
// `proof_type = typed_msg+garmin_sleep`. Stage A handles the typed-message
// half of the two-stage proof. Stage B (Garmin sleep onset) is Task 37.
//
// Behavior (design § 4):
//
//   1. On incoming text whose lowercased content contains the configured
//      `stage_a_phrase` (default "shutting down", substring match,
//      case-insensitive) AND whose arrival time is within
//      `stage_a_window_min` of `habit_runs.fired_at`:
//        - INSERT (OR REPLACE) into proof_stages with deterministic id
//          `proof-{runId}-a`, stage='a', satisfied=1.
//        - UPDATE habit_runs SET status='partial', next_escalation_at=NULL.
//        - Post ack to #wind-down: "Got it. Garmin will tell us the rest."
//        - Return outcome='partial' with proofPayload describing stage A.
//   2. If phrase matches but the window has already closed (e.g. wind-down
//      is already at L4+): return outcome='pending' with reason. No DB
//      writes. No Discord post.
//   3. If phrase doesn't match (message unrelated): return outcome='pending'.
//      No DB writes. No Discord post.
//
// Asymmetry vs Tasks 34/35: those sub-verbs return outcomes WITHOUT writing
// to the DB or posting to Discord — the caller handles state transitions.
// Task 36 is different: per design § 4, stage A satisfaction TRIGGERS the
// partial transition + proof_stages row + Discord ack inline, because those
// side effects ARE the stage-A handling. The asymmetry is documented in
// `src/orchestrate/verify-proof.ts` next to the implementation.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 36
//   - docs/plans/2026-05-12-habit-daemon-design.md § 4 (proof verification)
//   - src/lib/discord-adapter.ts (DiscordAdapter, PostResult, ChannelName)
//   - src/orchestrate/verify-proof.ts (Task 33 routing + Tasks 34/35 sub-verbs)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Client, Message } from "discord.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import { SessionStore } from "../../src/daemon/session-store.js";
import {
  createDiscordAdapter,
  type DiscordAdapter,
  type PostResult,
} from "../../src/lib/discord-adapter.js";
import { makeVerifyWindDownStageA } from "../../src/orchestrate/verify-proof.js";

// -----------------------------------------------------------------------------
// Fixtures.
// -----------------------------------------------------------------------------

const SEED_CHANNELS = {
  morningRow: "1000000000000000001",
  strength: "1000000000000000002",
  windDown: "1000000000000000003",
} as const;

const SESSION_ID = "session-verify-wd-0001";
const RUN_ID = "run-verify-wd-0001";
const FIRE_DATE = "2026-05-11";
// 10:00pm UTC — wind-down fire time.
const FIRED_AT_MS = Date.parse("2026-05-11T22:00:00.000Z");
// 5 minutes after fire — well within the 15-min stage_a_window.
const NOW_MS_IN_WINDOW = FIRED_AT_MS + 5 * 60_000;
// 20 minutes after fire — 5 min past the stage_a_window close.
const NOW_MS_OUT_OF_WINDOW = FIRED_AT_MS + 20 * 60_000;

const STAGE_A_ACK = "Got it. Garmin will tell us the rest.";

// -----------------------------------------------------------------------------
// Test helpers.
// -----------------------------------------------------------------------------

function buildAdapter(): DiscordAdapter {
  // The sub-verb routes its Discord post through the injected postImpl, so
  // the underlying client is never touched. We still build a real adapter so
  // the value passed through to postImpl is structurally a DiscordAdapter.
  const mockClient = {
    channels: {
      fetch: vi.fn().mockRejectedValue(new Error("client.channels.fetch should not be called when postImpl is injected")),
    },
  };
  return createDiscordAdapter({
    botToken: "test-bot-token",
    channelIds: {
      "morning-row": SEED_CHANNELS.morningRow,
      strength: SEED_CHANNELS.strength,
      "wind-down": SEED_CHANNELS.windDown,
      wins: "1000000000000000004",
      "sunday-review": "1000000000000000005",
    },
    clientFactory: () => mockClient as unknown as Client,
  });
}

function makeMessage(content: string): Message {
  return {
    id: "m-verify-wd-1",
    channelId: SEED_CHANNELS.windDown,
    content,
    author: { bot: false },
    // Empty attachments map — wind-down stage A is text-only.
    attachments: new Map(),
  } as unknown as Message;
}

function seedRun(
  db: Database.Database,
  opts: {
    runId?: string;
    firedAt?: number;
    currentLevel?: number;
    status?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId ?? RUN_ID,
    "wind-down",
    FIRE_DATE,
    opts.firedAt ?? FIRED_AT_MS,
    opts.currentLevel ?? 1,
    // Pretend an escalation is scheduled — the sub-verb must clear it on partial.
    (opts.firedAt ?? FIRED_AT_MS) + 5 * 60_000,
    opts.status ?? "pending",
    null,
    null,
    null,
    0,
  );
}

interface PostCall {
  readonly adapter: DiscordAdapter;
  readonly channel: "wind-down";
  readonly content: string;
}

function makeRecordingPostImpl(
  result: PostResult = {
    messageId: "msg-stage-a-ack",
    channelId: SEED_CHANNELS.windDown,
    postedAt: Date.parse("2026-05-11T22:05:00.000Z"),
  },
): {
  readonly impl: (opts: PostCall) => Promise<PostResult>;
  readonly calls: PostCall[];
} {
  const calls: PostCall[] = [];
  const impl = async (opts: PostCall): Promise<PostResult> => {
    calls.push(opts);
    return result;
  };
  return { impl, calls };
}

function makeThrowingPostImpl(
  err: Error,
): (opts: PostCall) => Promise<PostResult> {
  return async () => {
    throw err;
  };
}

interface RunRow {
  readonly status: string;
  readonly next_escalation_at: number | null;
}

function readRun(db: Database.Database, runId: string): RunRow {
  return db
    .prepare("SELECT status, next_escalation_at FROM habit_runs WHERE id = ?")
    .get(runId) as RunRow;
}

interface ProofStageRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage: string;
  readonly satisfied: number;
  readonly satisfied_at: number | null;
  readonly data_json: string | null;
}

function readProofStages(
  db: Database.Database,
  runId: string,
): readonly ProofStageRow[] {
  return db
    .prepare("SELECT id, run_id, stage, satisfied, satisfied_at, data_json FROM proof_stages WHERE run_id = ?")
    .all(runId) as readonly ProofStageRow[];
}

// -----------------------------------------------------------------------------
// Common setup shared by every describe block.
// -----------------------------------------------------------------------------

async function buildHarness(): Promise<{
  tempDir: string;
  sessionStore: SessionStore;
  db: Database.Database;
  adapter: DiscordAdapter;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-verify-wd-"));
  const dbPath = join(tempDir, "store.db");

  const migrator = openDatabase(dbPath);
  await runMigrations(migrator, loadMigrations());
  seedHabits(migrator, SEED_CHANNELS);
  migrator.close();

  const sessionStore = new SessionStore({ dbPath });
  return {
    tempDir,
    sessionStore,
    db: sessionStore.db,
    adapter: buildAdapter(),
  };
}

// Silence the expected stderr log when testing post-failure paths.
function withSilencedStderr<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return fn().finally(() => spy.mockRestore());
}

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

describe("makeVerifyWindDownStageA() — phrase match within window", () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(() => {
    harness.sessionStore.close();
    rmSync(harness.tempDir, { recursive: true, force: true });
  });

  it("transitions run to partial, writes proof_stages row, clears next_escalation_at, and posts ack", async () => {
    seedRun(harness.db, { firedAt: FIRED_AT_MS, currentLevel: 1 });
    const post = makeRecordingPostImpl();

    const subVerb = makeVerifyWindDownStageA({
      adapter: harness.adapter,
      postImpl: post.impl,
    });

    const result = await subVerb({
      sessionStore: harness.sessionStore,
      sessionId: SESSION_ID,
      habitId: "wind-down",
      runId: RUN_ID,
      message: makeMessage("shutting down"),
      now: NOW_MS_IN_WINDOW,
    });

    expect(result.outcome).toBe("partial");
    const payload = result.proofPayload as {
      stage: string;
      satisfied_at: number;
      message_text: string;
    };
    expect(payload.stage).toBe("a");
    expect(payload.satisfied_at).toBe(NOW_MS_IN_WINDOW);
    expect(payload.message_text).toBe("shutting down");

    const run = readRun(harness.db, RUN_ID);
    expect(run.status).toBe("partial");
    expect(run.next_escalation_at).toBeNull();

    const stages = readProofStages(harness.db, RUN_ID);
    expect(stages).toHaveLength(1);
    expect(stages[0]!.stage).toBe("a");
    expect(stages[0]!.satisfied).toBe(1);
    expect(stages[0]!.satisfied_at).toBe(NOW_MS_IN_WINDOW);
    // Deterministic id so re-runs are idempotent.
    expect(stages[0]!.id).toContain(RUN_ID);

    expect(post.calls).toHaveLength(1);
    expect(post.calls[0]!.channel).toBe("wind-down");
    expect(post.calls[0]!.content).toBe(STAGE_A_ACK);
    expect(post.calls[0]!.adapter).toBe(harness.adapter);
  });

  it("is case-insensitive — 'Shutting Down' matches", async () => {
    seedRun(harness.db, { firedAt: FIRED_AT_MS, currentLevel: 1 });
    const post = makeRecordingPostImpl();

    const subVerb = makeVerifyWindDownStageA({
      adapter: harness.adapter,
      postImpl: post.impl,
    });

    const result = await subVerb({
      sessionStore: harness.sessionStore,
      sessionId: SESSION_ID,
      habitId: "wind-down",
      runId: RUN_ID,
      message: makeMessage("Shutting Down"),
      now: NOW_MS_IN_WINDOW,
    });

    expect(result.outcome).toBe("partial");
    expect(readRun(harness.db, RUN_ID).status).toBe("partial");
    expect(post.calls).toHaveLength(1);
  });

  it("supports substring match — 'I'm shutting down now, goodnight' satisfies stage A", async () => {
    seedRun(harness.db, { firedAt: FIRED_AT_MS, currentLevel: 1 });
    const post = makeRecordingPostImpl();

    const subVerb = makeVerifyWindDownStageA({
      adapter: harness.adapter,
      postImpl: post.impl,
    });

    const result = await subVerb({
      sessionStore: harness.sessionStore,
      sessionId: SESSION_ID,
      habitId: "wind-down",
      runId: RUN_ID,
      message: makeMessage("I'm shutting down now, goodnight"),
      now: NOW_MS_IN_WINDOW,
    });

    expect(result.outcome).toBe("partial");
    expect(readRun(harness.db, RUN_ID).status).toBe("partial");
    const stages = readProofStages(harness.db, RUN_ID);
    expect(stages).toHaveLength(1);
    expect(stages[0]!.satisfied).toBe(1);
  });
});

describe("makeVerifyWindDownStageA() — pending paths (no state change)", () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(() => {
    harness.sessionStore.close();
    rmSync(harness.tempDir, { recursive: true, force: true });
  });

  it("returns pending and writes nothing when the stage_a window has closed", async () => {
    seedRun(harness.db, { firedAt: FIRED_AT_MS, currentLevel: 4 });
    const post = makeRecordingPostImpl();

    const subVerb = makeVerifyWindDownStageA({
      adapter: harness.adapter,
      postImpl: post.impl,
    });

    const result = await subVerb({
      sessionStore: harness.sessionStore,
      sessionId: SESSION_ID,
      habitId: "wind-down",
      runId: RUN_ID,
      message: makeMessage("shutting down"),
      now: NOW_MS_OUT_OF_WINDOW,
    });

    expect(result.outcome).toBe("pending");
    expect(result.reason).toMatch(/window/i);

    // No DB writes.
    const run = readRun(harness.db, RUN_ID);
    expect(run.status).toBe("pending");
    expect(run.next_escalation_at).not.toBeNull();
    expect(readProofStages(harness.db, RUN_ID)).toHaveLength(0);

    // No Discord post.
    expect(post.calls).toHaveLength(0);
  });

  it("returns pending and writes nothing when the message does not contain the phrase", async () => {
    seedRun(harness.db, { firedAt: FIRED_AT_MS, currentLevel: 1 });
    const post = makeRecordingPostImpl();

    const subVerb = makeVerifyWindDownStageA({
      adapter: harness.adapter,
      postImpl: post.impl,
    });

    const result = await subVerb({
      sessionStore: harness.sessionStore,
      sessionId: SESSION_ID,
      habitId: "wind-down",
      runId: RUN_ID,
      message: makeMessage("Hey are you there?"),
      now: NOW_MS_IN_WINDOW,
    });

    expect(result.outcome).toBe("pending");

    const run = readRun(harness.db, RUN_ID);
    expect(run.status).toBe("pending");
    expect(run.next_escalation_at).not.toBeNull();
    expect(readProofStages(harness.db, RUN_ID)).toHaveLength(0);
    expect(post.calls).toHaveLength(0);
  });

  it("returns pending and writes nothing for an empty message", async () => {
    seedRun(harness.db, { firedAt: FIRED_AT_MS, currentLevel: 1 });
    const post = makeRecordingPostImpl();

    const subVerb = makeVerifyWindDownStageA({
      adapter: harness.adapter,
      postImpl: post.impl,
    });

    const result = await subVerb({
      sessionStore: harness.sessionStore,
      sessionId: SESSION_ID,
      habitId: "wind-down",
      runId: RUN_ID,
      message: makeMessage(""),
      now: NOW_MS_IN_WINDOW,
    });

    expect(result.outcome).toBe("pending");
    expect(readRun(harness.db, RUN_ID).status).toBe("pending");
    expect(readProofStages(harness.db, RUN_ID)).toHaveLength(0);
    expect(post.calls).toHaveLength(0);
  });
});

describe("makeVerifyWindDownStageA() — idempotency", () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(() => {
    harness.sessionStore.close();
    rmSync(harness.tempDir, { recursive: true, force: true });
  });

  it("does not create duplicate proof_stages rows when fired twice", async () => {
    seedRun(harness.db, { firedAt: FIRED_AT_MS, currentLevel: 1 });
    const post = makeRecordingPostImpl();

    const subVerb = makeVerifyWindDownStageA({
      adapter: harness.adapter,
      postImpl: post.impl,
    });

    // First invocation transitions to partial.
    await subVerb({
      sessionStore: harness.sessionStore,
      sessionId: SESSION_ID,
      habitId: "wind-down",
      runId: RUN_ID,
      message: makeMessage("shutting down"),
      now: NOW_MS_IN_WINDOW,
    });

    expect(readRun(harness.db, RUN_ID).status).toBe("partial");
    expect(readProofStages(harness.db, RUN_ID)).toHaveLength(1);

    // Second invocation: same deterministic id → upserts in place.
    const secondNow = NOW_MS_IN_WINDOW + 60_000; // still within window
    const result = await subVerb({
      sessionStore: harness.sessionStore,
      sessionId: SESSION_ID,
      habitId: "wind-down",
      runId: RUN_ID,
      message: makeMessage("shutting down"),
      now: secondNow,
    });

    expect(result.outcome).toBe("partial");
    const stages = readProofStages(harness.db, RUN_ID);
    expect(stages).toHaveLength(1);
    // Re-run refreshes satisfied_at to the latest invocation.
    expect(stages[0]!.satisfied_at).toBe(secondNow);

    const run = readRun(harness.db, RUN_ID);
    expect(run.status).toBe("partial");
    expect(run.next_escalation_at).toBeNull();
  });
});

describe("makeVerifyWindDownStageA() — post failure does not roll back DB", () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(() => {
    harness.sessionStore.close();
    rmSync(harness.tempDir, { recursive: true, force: true });
  });

  it("logs to stderr, leaves DB state in 'partial', and returns outcome='partial'", async () => {
    seedRun(harness.db, { firedAt: FIRED_AT_MS, currentLevel: 1 });

    const subVerb = makeVerifyWindDownStageA({
      adapter: harness.adapter,
      postImpl: makeThrowingPostImpl(new Error("discord 500")),
    });

    await withSilencedStderr(async () => {
      const result = await subVerb({
        sessionStore: harness.sessionStore,
        sessionId: SESSION_ID,
        habitId: "wind-down",
        runId: RUN_ID,
        message: makeMessage("shutting down"),
        now: NOW_MS_IN_WINDOW,
      });

      expect(result.outcome).toBe("partial");
    });

    // DB state survives the post failure.
    const run = readRun(harness.db, RUN_ID);
    expect(run.status).toBe("partial");
    expect(run.next_escalation_at).toBeNull();

    const stages = readProofStages(harness.db, RUN_ID);
    expect(stages).toHaveLength(1);
    expect(stages[0]!.satisfied).toBe(1);
  });
});

describe("makeVerifyWindDownStageA() — stage_a_phrase from proof_config", () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(() => {
    harness.sessionStore.close();
    rmSync(harness.tempDir, { recursive: true, force: true });
  });

  it("uses an overridden stage_a_phrase ('goodnight') from the habit's proof_config", async () => {
    // Override the wind-down habit's proof_config_json to use a new phrase.
    harness.db
      .prepare("UPDATE habits SET proof_config_json = ? WHERE id = 'wind-down'")
      .run(
        JSON.stringify({
          stage_a_phrase: "goodnight",
          stage_a_window_min: 15,
          stage_b_threshold: "23:00",
        }),
      );

    seedRun(harness.db, { firedAt: FIRED_AT_MS, currentLevel: 1 });
    const post = makeRecordingPostImpl();

    const subVerb = makeVerifyWindDownStageA({
      adapter: harness.adapter,
      postImpl: post.impl,
    });

    // The old default phrase no longer matches.
    const noMatch = await subVerb({
      sessionStore: harness.sessionStore,
      sessionId: SESSION_ID,
      habitId: "wind-down",
      runId: RUN_ID,
      message: makeMessage("shutting down"),
      now: NOW_MS_IN_WINDOW,
    });
    expect(noMatch.outcome).toBe("pending");
    expect(readRun(harness.db, RUN_ID).status).toBe("pending");

    // The new phrase matches.
    const result = await subVerb({
      sessionStore: harness.sessionStore,
      sessionId: SESSION_ID,
      habitId: "wind-down",
      runId: RUN_ID,
      message: makeMessage("goodnight"),
      now: NOW_MS_IN_WINDOW,
    });
    expect(result.outcome).toBe("partial");
    expect(readRun(harness.db, RUN_ID).status).toBe("partial");
    expect(post.calls).toHaveLength(1);
  });
});
