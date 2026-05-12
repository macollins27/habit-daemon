// Task 35: verifyTrainingLogPhoto sub-verb tests.
//
// The sub-verb is the proof-verification path for `strength-mwf` whose
// `proof_type = training_log_photo`. Behavior (design § 4):
//
//   1. If the inbound Discord message has no image attachment → pending
//      (no claim made; caller does NOT bump vision_rejection_count).
//   2. If image attachment present → dispatch verifyImage(subject='training_log')
//      over the first image attachment.
//      → vision pass (is_training_log=true, entries_visible>=3, confidence>=0.7)
//        → completed (proofPayload = {source:'photo', parsed: …}).
//      → vision fail → rejected (proofPayload = {source:'photo', parsed: …}).
//
// The sub-verb is constructed via the `makeVerifyTrainingLogPhoto` factory so
// production callers (Task 39+) can inject the vision dispatch impl while
// tests pass mocks. The sub-verb itself performs NO habit_runs writes and
// NO recordVisionRejection calls — the caller translates the
// VerifyProofResult into a status transition and counter bump (consistent
// with Task 34's pattern).
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 35
//   - docs/plans/2026-05-12-habit-daemon-design.md § 4 (proof verification)
//   - src/lib/vision-verify.ts (verifyImage + DispatchResult)
//   - src/lib/vision-registry.ts (training_log thresholds: entries>=3, confidence>=0.7)
//   - src/orchestrate/verify-proof.ts (Task 33 routing + Task 34 concept2 precedent)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import type { DispatchResult } from "../../src/lib/vision-verify.js";
import { makeVerifyTrainingLogPhoto } from "../../src/orchestrate/verify-proof.js";

// -----------------------------------------------------------------------------
// Fixtures.
// -----------------------------------------------------------------------------

const SEED_CHANNELS = {
  morningRow: "1000000000000000001",
  strength: "1000000000000000002",
  windDown: "1000000000000000003",
} as const;

const SESSION_ID = "session-verify-tlog-0001";
const RUN_ID = "run-verify-tlog-0001";
const FIRE_DATE = "2026-05-11"; // Mon 2026-05-11 — strength fire date.
// 18:55 UTC — strength fires at 18:20 cron, so this is an L1-ish wall time.
const NOW_MS = Date.parse("2026-05-11T18:55:00.000Z");

// -----------------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------------

interface AttachmentLike {
  readonly url: string;
  readonly contentType: string | null;
}

function makeMessage(attachments: readonly AttachmentLike[] = []): Message {
  const map = new Map<string, AttachmentLike>();
  attachments.forEach((a, idx) => {
    map.set(`attach-${idx}`, a);
  });
  return {
    id: "m-verify-tlog-1",
    channelId: SEED_CHANNELS.strength,
    content: "proof attached",
    author: { bot: false },
    attachments: map,
  } as unknown as Message;
}

function seedRun(
  db: Database.Database,
  opts: {
    runId?: string;
    habitId?: string;
    currentLevel: number;
    fireDate?: string;
    firedAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId ?? RUN_ID,
    opts.habitId ?? "strength-mwf",
    opts.fireDate ?? FIRE_DATE,
    opts.firedAt ?? Date.parse("2026-05-11T18:20:00.000Z"),
    opts.currentLevel,
    null,
    "pending",
    null,
    null,
    null,
    0,
  );
}

function makeVisionDispatchMock(
  result: DispatchResult,
): (opts: { prompt: string; jsonSchema: string }) => Promise<DispatchResult> {
  return async () => result;
}

function makeVisionDispatchMockThrowing(
  err: Error,
): (opts: { prompt: string; jsonSchema: string }) => Promise<DispatchResult> {
  return async () => {
    throw err;
  };
}

/**
 * Capture-style mock: records each call's args so tests can assert the
 * dispatched prompt (the prompt embeds the registry prompt which mentions
 * "training log" — that's how we verify subject='training_log' was used).
 */
interface CaptureSlot {
  readonly calls: Array<{ prompt: string; jsonSchema: string }>;
}

function makeCapturingVisionMock(
  result: DispatchResult,
): {
  readonly impl: (opts: {
    prompt: string;
    jsonSchema: string;
  }) => Promise<DispatchResult>;
  readonly slot: CaptureSlot;
} {
  const slot: CaptureSlot = { calls: [] };
  const impl = async (opts: {
    prompt: string;
    jsonSchema: string;
  }): Promise<DispatchResult> => {
    slot.calls.push({ prompt: opts.prompt, jsonSchema: opts.jsonSchema });
    return result;
  };
  return { impl, slot };
}

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

describe("makeVerifyTrainingLogPhoto() — happy path", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-verify-tlog-"));
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

  it("returns completed when vision passes (is_training_log, 5 entries, conf 0.9)", async () => {
    seedRun(db, { currentLevel: 1 });

    const subVerb = makeVerifyTrainingLogPhoto({
      visionDispatchImpl: makeVisionDispatchMock({
        structured_output: {
          is_training_log: true,
          entries_visible: 5,
          confidence: 0.9,
        },
      }),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "strength-mwf",
      runId: RUN_ID,
      message: makeMessage([
        {
          url: "https://cdn.discordapp.com/log.jpg",
          contentType: "image/jpeg",
        },
      ]),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("completed");
    const payload = result.proofPayload as {
      source: string;
      parsed: {
        is_training_log: boolean;
        entries_visible: number;
        confidence: number;
      };
    };
    expect(payload.source).toBe("photo");
    expect(payload.parsed.is_training_log).toBe(true);
    expect(payload.parsed.entries_visible).toBe(5);
    expect(payload.parsed.confidence).toBe(0.9);
  });

  it("returns completed at the exact thresholds (3 entries, confidence 0.7)", async () => {
    seedRun(db, { currentLevel: 2 });

    const subVerb = makeVerifyTrainingLogPhoto({
      visionDispatchImpl: makeVisionDispatchMock({
        structured_output: {
          is_training_log: true,
          entries_visible: 3,
          confidence: 0.7,
        },
      }),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "strength-mwf",
      runId: RUN_ID,
      message: makeMessage([
        { url: "https://cdn.discordapp.com/log2.png", contentType: "image/png" },
      ]),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("completed");
    const payload = result.proofPayload as {
      source: string;
      parsed: { entries_visible: number };
    };
    expect(payload.source).toBe("photo");
    expect(payload.parsed.entries_visible).toBe(3);
  });
});

describe("makeVerifyTrainingLogPhoto() — vision rejection paths", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-verify-tlog-"));
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

  it("returns rejected when vision says not a training log (reason mentions 'training log')", async () => {
    seedRun(db, { currentLevel: 1 });

    const subVerb = makeVerifyTrainingLogPhoto({
      visionDispatchImpl: makeVisionDispatchMock({
        structured_output: {
          is_training_log: false,
          entries_visible: 0,
          confidence: 0.1,
        },
      }),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "strength-mwf",
      runId: RUN_ID,
      message: makeMessage([
        { url: "https://cdn.discordapp.com/cat.jpg", contentType: "image/jpeg" },
      ]),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("rejected");
    expect(result.reason?.toLowerCase()).toMatch(/training log/);
    const payload = result.proofPayload as {
      source: string;
      parsed: { is_training_log: boolean };
    };
    expect(payload.source).toBe("photo");
    expect(payload.parsed.is_training_log).toBe(false);
  });

  it("returns rejected when entries_visible is below the threshold (reason mentions '2 entries')", async () => {
    seedRun(db, { currentLevel: 2 });

    const subVerb = makeVerifyTrainingLogPhoto({
      visionDispatchImpl: makeVisionDispatchMock({
        structured_output: {
          is_training_log: true,
          entries_visible: 2,
          confidence: 0.95,
        },
      }),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "strength-mwf",
      runId: RUN_ID,
      message: makeMessage([
        { url: "https://cdn.discordapp.com/log.png", contentType: "image/png" },
      ]),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("rejected");
    expect(result.reason?.toLowerCase()).toMatch(/2 entries/);
    const payload = result.proofPayload as {
      source: string;
      parsed: { entries_visible: number };
    };
    expect(payload.source).toBe("photo");
    expect(payload.parsed.entries_visible).toBe(2);
  });

  it("returns rejected when confidence is below 0.7 (reason mentions 'confidence')", async () => {
    seedRun(db, { currentLevel: 3 });

    const subVerb = makeVerifyTrainingLogPhoto({
      visionDispatchImpl: makeVisionDispatchMock({
        structured_output: {
          is_training_log: true,
          entries_visible: 4,
          confidence: 0.5,
        },
      }),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "strength-mwf",
      runId: RUN_ID,
      message: makeMessage([
        { url: "https://cdn.discordapp.com/blur.jpg", contentType: "image/jpeg" },
      ]),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("rejected");
    expect(result.reason?.toLowerCase()).toMatch(/confidence/);
    const payload = result.proofPayload as {
      source: string;
      parsed: { confidence: number };
    };
    expect(payload.source).toBe("photo");
    expect(payload.parsed.confidence).toBe(0.5);
  });
});

describe("makeVerifyTrainingLogPhoto() — pending paths (no claim made)", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-verify-tlog-"));
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

  it("returns pending when the message has no attachments (vision NOT called)", async () => {
    seedRun(db, { currentLevel: 1 });

    const subVerb = makeVerifyTrainingLogPhoto({
      // Throwing impl proves vision was never invoked.
      visionDispatchImpl: makeVisionDispatchMockThrowing(
        new Error("vision should not be called when no attachment"),
      ),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "strength-mwf",
      runId: RUN_ID,
      message: makeMessage(),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("pending");
    expect(result.proofPayload).toBeUndefined();
  });

  it("returns pending when the only attachment is non-image (vision NOT called)", async () => {
    seedRun(db, { currentLevel: 2 });

    const subVerb = makeVerifyTrainingLogPhoto({
      visionDispatchImpl: makeVisionDispatchMockThrowing(
        new Error("vision should not be called for non-image attachment"),
      ),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "strength-mwf",
      runId: RUN_ID,
      message: makeMessage([
        {
          url: "https://cdn.discordapp.com/clip.mp4",
          contentType: "video/mp4",
        },
      ]),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("pending");
    expect(result.proofPayload).toBeUndefined();
  });
});

describe("makeVerifyTrainingLogPhoto() — error propagation", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-verify-tlog-"));
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

  it("propagates vision dispatch errors", async () => {
    seedRun(db, { currentLevel: 1 });

    const subVerb = makeVerifyTrainingLogPhoto({
      visionDispatchImpl: makeVisionDispatchMockThrowing(
        new Error("vision dispatch crashed"),
      ),
    });

    await expect(
      subVerb({
        sessionStore,
        sessionId: SESSION_ID,
        habitId: "strength-mwf",
        runId: RUN_ID,
        message: makeMessage([
          {
            url: "https://cdn.discordapp.com/log.jpg",
            contentType: "image/jpeg",
          },
        ]),
        now: NOW_MS,
      }),
    ).rejects.toThrow(/vision dispatch crashed/);
  });
});

describe("makeVerifyTrainingLogPhoto() — dispatch wiring", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-verify-tlog-"));
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

  it("calls verifyImage with subject='training_log' (prompt embeds the registry prompt + image URL)", async () => {
    seedRun(db, { currentLevel: 1 });

    const { impl, slot } = makeCapturingVisionMock({
      structured_output: {
        is_training_log: true,
        entries_visible: 4,
        confidence: 0.85,
      },
    });

    const subVerb = makeVerifyTrainingLogPhoto({
      visionDispatchImpl: impl,
    });

    const imageUrl = "https://cdn.discordapp.com/strength-log.jpg";
    await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "strength-mwf",
      runId: RUN_ID,
      message: makeMessage([{ url: imageUrl, contentType: "image/jpeg" }]),
      now: NOW_MS,
    });

    expect(slot.calls).toHaveLength(1);
    const call = slot.calls[0]!;
    // The verifyImage wrapper builds: `Image to verify: <url>\n\n<registry prompt>`.
    // The registry's training_log prompt mentions "workout/training log" verbatim,
    // which is how we verify subject='training_log' was the lookup key.
    expect(call.prompt).toContain(imageUrl);
    expect(call.prompt.toLowerCase()).toMatch(/training log/);
    // The JSON schema must include the training_log response fields.
    expect(call.jsonSchema).toContain("is_training_log");
    expect(call.jsonSchema).toContain("entries_visible");
  });
});
