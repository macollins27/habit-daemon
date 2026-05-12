// Task 33: verify-proof routing scaffold tests.
//
// The verb is the orchestrator for proof verification. Tasks 34/35/36 each
// implement one of the three sub-verbs:
//   - verifyConcept2OrPhoto     (proof_type = concept2_api+photo_fallback)
//   - verifyTrainingLogPhoto    (proof_type = training_log_photo)
//   - verifyWindDownStageA      (proof_type = typed_msg+garmin_sleep)
//
// Task 33 builds only the router. Sub-verbs are dependency-injected via
// `opts.subVerbs` (the same DI-seam pattern habit-checkin uses for
// dispatchImpl / postImpl). These tests inject vi.fn() mocks per sub-verb
// and assert routing by habit.proof_type.
//
// Out of scope (Tasks 34/35/36):
//   - real sub-verb implementations
//   - DB writes from the router itself (sub-verbs own that)
//   - Discord message inspection (router passes the Message through unchanged)
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 33
//   - src/orchestrate/habit-checkin.ts (DI-seam precedent)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Message } from "discord.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import { SessionStore } from "../../src/daemon/session-store.js";
import {
  verifyProof,
  type SubVerb,
  type SubVerbContext,
  type VerifyProofResult,
} from "../../src/orchestrate/verify-proof.js";

const SEED_CHANNELS = {
  morningRow: "1000000000000000001",
  strength: "1000000000000000002",
  windDown: "1000000000000000003",
} as const;

const SESSION_ID = "session-verify-proof-0001";
const RUN_ID = "run-verify-proof-0001";
const NOW_MS = Date.parse("2026-05-12T09:35:00.000Z");

function makeMessage(): Message {
  return {
    id: "m-verify-proof-1",
    channelId: SEED_CHANNELS.morningRow,
    content: "proof attached",
    author: { bot: false },
    attachments: new Map(),
  } as unknown as Message;
}

function makeSubVerb(
  result: VerifyProofResult,
): ReturnType<typeof vi.fn<Parameters<SubVerb>, ReturnType<SubVerb>>> {
  return vi.fn(async () => result);
}

function defaultResult(): VerifyProofResult {
  return { outcome: "pending" };
}

describe("verifyProof()", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-verify-proof-"));
    dbPath = join(tempDir, "store.db");

    const migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
    seedHabits(migrator, SEED_CHANNELS);
    migrator.close();

    sessionStore = new SessionStore({ dbPath });
    db = sessionStore.db;
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("routes morning-row (concept2_api+photo_fallback) to verifyConcept2OrPhoto", async () => {
    const concept2 = makeSubVerb(defaultResult());
    const trainingLog = makeSubVerb(defaultResult());
    const windDown = makeSubVerb(defaultResult());

    await verifyProof({
      db,
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      message: makeMessage(),
      now: NOW_MS,
      subVerbs: {
        verifyConcept2OrPhoto: concept2,
        verifyTrainingLogPhoto: trainingLog,
        verifyWindDownStageA: windDown,
      },
    });

    expect(concept2).toHaveBeenCalledTimes(1);
    expect(trainingLog).not.toHaveBeenCalled();
    expect(windDown).not.toHaveBeenCalled();
  });

  it("routes strength-mwf (training_log_photo) to verifyTrainingLogPhoto", async () => {
    const concept2 = makeSubVerb(defaultResult());
    const trainingLog = makeSubVerb(defaultResult());
    const windDown = makeSubVerb(defaultResult());

    await verifyProof({
      db,
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "strength-mwf",
      runId: RUN_ID,
      message: makeMessage(),
      now: NOW_MS,
      subVerbs: {
        verifyConcept2OrPhoto: concept2,
        verifyTrainingLogPhoto: trainingLog,
        verifyWindDownStageA: windDown,
      },
    });

    expect(trainingLog).toHaveBeenCalledTimes(1);
    expect(concept2).not.toHaveBeenCalled();
    expect(windDown).not.toHaveBeenCalled();
  });

  it("routes wind-down (typed_msg+garmin_sleep) to verifyWindDownStageA", async () => {
    const concept2 = makeSubVerb(defaultResult());
    const trainingLog = makeSubVerb(defaultResult());
    const windDown = makeSubVerb(defaultResult());

    await verifyProof({
      db,
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "wind-down",
      runId: RUN_ID,
      message: makeMessage(),
      now: NOW_MS,
      subVerbs: {
        verifyConcept2OrPhoto: concept2,
        verifyTrainingLogPhoto: trainingLog,
        verifyWindDownStageA: windDown,
      },
    });

    expect(windDown).toHaveBeenCalledTimes(1);
    expect(concept2).not.toHaveBeenCalled();
    expect(trainingLog).not.toHaveBeenCalled();
  });

  it("returns the sub-verb's result verbatim", async () => {
    const payload: VerifyProofResult = {
      outcome: "completed",
      proofPayload: { meters: 2143, durationSec: 720 },
    };
    const concept2 = makeSubVerb(payload);

    const result = await verifyProof({
      db,
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      message: makeMessage(),
      now: NOW_MS,
      subVerbs: {
        verifyConcept2OrPhoto: concept2,
        verifyTrainingLogPhoto: makeSubVerb(defaultResult()),
        verifyWindDownStageA: makeSubVerb(defaultResult()),
      },
    });

    expect(result).toEqual(payload);
  });

  it("forwards SubVerbContext (sessionStore, sessionId, habitId, runId, message, now) to the sub-verb", async () => {
    const concept2 = makeSubVerb(defaultResult());
    const msg = makeMessage();

    await verifyProof({
      db,
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      message: msg,
      now: NOW_MS,
      subVerbs: {
        verifyConcept2OrPhoto: concept2,
        verifyTrainingLogPhoto: makeSubVerb(defaultResult()),
        verifyWindDownStageA: makeSubVerb(defaultResult()),
      },
    });

    expect(concept2).toHaveBeenCalledTimes(1);
    const ctx = concept2.mock.calls[0]![0] as SubVerbContext;
    expect(ctx.sessionStore).toBe(sessionStore);
    expect(ctx.sessionId).toBe(SESSION_ID);
    expect(ctx.habitId).toBe("morning-row");
    expect(ctx.runId).toBe(RUN_ID);
    expect(ctx.message).toBe(msg);
    expect(ctx.now).toBe(NOW_MS);
  });

  it("throws when the habit id is not found", async () => {
    await expect(
      verifyProof({
        db,
        sessionStore,
        sessionId: SESSION_ID,
        habitId: "nonexistent",
        runId: RUN_ID,
        message: makeMessage(),
        now: NOW_MS,
        subVerbs: {
          verifyConcept2OrPhoto: makeSubVerb(defaultResult()),
          verifyTrainingLogPhoto: makeSubVerb(defaultResult()),
          verifyWindDownStageA: makeSubVerb(defaultResult()),
        },
      }),
    ).rejects.toThrow(/nonexistent/);
  });

  it("throws on unknown proof_type", async () => {
    db.prepare(
      `INSERT INTO habits (
        id, name, domain, cron_expr, why_stakes_json,
        proof_type, proof_config_json, channel_id, active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "weird-habit",
      "Weird",
      "row",
      "0 0 * * *",
      "{}",
      "bogus",
      "{}",
      SEED_CHANNELS.morningRow,
      1,
      Date.now(),
    );

    await expect(
      verifyProof({
        db,
        sessionStore,
        sessionId: SESSION_ID,
        habitId: "weird-habit",
        runId: RUN_ID,
        message: makeMessage(),
        now: NOW_MS,
        subVerbs: {
          verifyConcept2OrPhoto: makeSubVerb(defaultResult()),
          verifyTrainingLogPhoto: makeSubVerb(defaultResult()),
          verifyWindDownStageA: makeSubVerb(defaultResult()),
        },
      }),
    ).rejects.toThrow(/Unknown proof_type: bogus/);
  });

  it("throws when the chosen sub-verb is not injected", async () => {
    await expect(
      verifyProof({
        db,
        sessionStore,
        sessionId: SESSION_ID,
        habitId: "morning-row",
        runId: RUN_ID,
        message: makeMessage(),
        now: NOW_MS,
        subVerbs: {
          // verifyConcept2OrPhoto deliberately omitted
          verifyTrainingLogPhoto: makeSubVerb(defaultResult()),
          verifyWindDownStageA: makeSubVerb(defaultResult()),
        },
      }),
    ).rejects.toThrow(/verifyConcept2OrPhoto not yet wired/);
  });

  it("throws when opts.subVerbs is omitted entirely", async () => {
    await expect(
      verifyProof({
        db,
        sessionStore,
        sessionId: SESSION_ID,
        habitId: "morning-row",
        runId: RUN_ID,
        message: makeMessage(),
        now: NOW_MS,
      }),
    ).rejects.toThrow(/verifyConcept2OrPhoto not yet wired/);
  });

  it("propagates errors thrown by the sub-verb", async () => {
    const boom = vi.fn(async () => {
      throw new Error("subverb-boom");
    });

    await expect(
      verifyProof({
        db,
        sessionStore,
        sessionId: SESSION_ID,
        habitId: "morning-row",
        runId: RUN_ID,
        message: makeMessage(),
        now: NOW_MS,
        subVerbs: {
          verifyConcept2OrPhoto: boom,
          verifyTrainingLogPhoto: makeSubVerb(defaultResult()),
          verifyWindDownStageA: makeSubVerb(defaultResult()),
        },
      }),
    ).rejects.toThrow(/subverb-boom/);
  });

  it("missing sub-verb for training_log_photo throws with verb name", async () => {
    await expect(
      verifyProof({
        db,
        sessionStore,
        sessionId: SESSION_ID,
        habitId: "strength-mwf",
        runId: RUN_ID,
        message: makeMessage(),
        now: NOW_MS,
        subVerbs: {
          verifyConcept2OrPhoto: makeSubVerb(defaultResult()),
          // verifyTrainingLogPhoto omitted
          verifyWindDownStageA: makeSubVerb(defaultResult()),
        },
      }),
    ).rejects.toThrow(/verifyTrainingLogPhoto not yet wired/);
  });

  it("missing sub-verb for typed_msg+garmin_sleep throws with verb name", async () => {
    await expect(
      verifyProof({
        db,
        sessionStore,
        sessionId: SESSION_ID,
        habitId: "wind-down",
        runId: RUN_ID,
        message: makeMessage(),
        now: NOW_MS,
        subVerbs: {
          verifyConcept2OrPhoto: makeSubVerb(defaultResult()),
          verifyTrainingLogPhoto: makeSubVerb(defaultResult()),
          // verifyWindDownStageA omitted
        },
      }),
    ).rejects.toThrow(/verifyWindDownStageA not yet wired/);
  });
});
