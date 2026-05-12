// Task 34: verifyConcept2OrPhoto sub-verb tests.
//
// The sub-verb is the proof-verification path for `morning-row` whose
// `proof_type = concept2_api+photo_fallback`. Behavior (design § 4):
//
//   1. Sync today's Concept2 rows into `sensor_signals`, then look for a
//      qualifying rower session (duration_seconds >= min_minutes*60).
//   2. If found → completed (proof source = 'concept2').
//   3. If not found AND habit_run.current_level >= fallback_required_at_level
//      AND the inbound Discord message has an image attachment →
//      run vision verifyImage('pm5_screen') over the attachment.
//      → vision pass → completed (proof source = 'photo')
//      → vision fail → rejected (proof source = 'photo')
//   4. Otherwise → pending (no claim made).
//
// The sub-verb is constructed via the `makeVerifyConcept2OrPhoto` factory
// so production callers (Task 39+) can inject the Concept2 OAuth state and
// vision dispatch impl, while tests inject mocks for `fetchImpl`,
// `onTokensRefreshed`, and `visionDispatchImpl`. The sub-verb itself
// performs NO habit_runs writes — the caller translates the
// VerifyProofResult into a status transition.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 34
//   - docs/plans/2026-05-12-habit-daemon-design.md § 4 (proof verification)
//   - src/lib/concept2-adapter.ts (syncDate)
//   - src/lib/vision-verify.ts (verifyImage + DispatchResult)
//   - src/orchestrate/verify-proof.ts (Task 33 routing scaffold)

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
import type {
  Concept2Credentials,
  Concept2Result,
  Concept2Tokens,
} from "../../src/lib/concept2-adapter.js";
import type { DispatchResult } from "../../src/lib/vision-verify.js";
import { makeVerifyConcept2OrPhoto } from "../../src/orchestrate/verify-proof.js";

// -----------------------------------------------------------------------------
// Fixtures.
// -----------------------------------------------------------------------------

const SEED_CHANNELS = {
  morningRow: "1000000000000000001",
  strength: "1000000000000000002",
  windDown: "1000000000000000003",
} as const;

const SESSION_ID = "session-verify-concept2-0001";
const RUN_ID = "run-verify-concept2-0001";
const FIRE_DATE = "2026-05-12";
// 9:35 UTC — the morning row fires at 9:05 cron, so this is L2-ish wall time.
const NOW_MS = Date.parse("2026-05-12T09:35:00.000Z");

const VALID_CREDS: Concept2Credentials = {
  client_id: "test-client-id",
  client_secret: "test-client-secret",
  redirect_uri: "http://localhost:8765/concept2/callback",
};

const VALID_TOKENS: Concept2Tokens = {
  access_token: "AT-original",
  refresh_token: "RT-original",
  expires_at: Date.parse("2026-05-13T00:00:00.000Z"),
  token_type: "Bearer",
  scope: "user:read,results:read",
};

// 12-minute rower session — qualifies for the morning-row min_minutes=10.
const ROWER_12MIN: Concept2Result = {
  id: 201,
  date: "2026-05-12 09:15:00",
  type: "rower",
  duration_seconds: 720,
  distance_meters: 2143,
};

// 5-minute rower session — under the min_minutes=10 floor.
const ROWER_5MIN: Concept2Result = {
  id: 202,
  date: "2026-05-12 09:18:00",
  type: "rower",
  duration_seconds: 300,
  distance_meters: 900,
};

// Another short rower session (4 min).
const ROWER_4MIN: Concept2Result = {
  id: 203,
  date: "2026-05-12 09:20:00",
  type: "rower",
  duration_seconds: 240,
  distance_meters: 700,
};

// Mid-length 11-minute rower — qualifies.
const ROWER_11MIN: Concept2Result = {
  id: 204,
  date: "2026-05-12 09:25:00",
  type: "rower",
  duration_seconds: 660,
  distance_meters: 2000,
};

// -----------------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------------

interface CannedResponse {
  ok: boolean;
  status?: number;
  body: unknown;
}

function makeFetchMock(responses: readonly CannedResponse[]): typeof fetch {
  let index = 0;
  return (async (): Promise<Response> => {
    if (index >= responses.length) {
      throw new Error(
        `fetch mock exhausted: call #${index + 1} but only ${responses.length} canned responses`,
      );
    }
    const response = responses[index++]!;
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 400),
      json: async () => response.body,
      text: async () =>
        typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body),
    } as Response;
  }) as typeof fetch;
}

function makeFetchMockThrowing(err: Error): typeof fetch {
  return (async (): Promise<Response> => {
    throw err;
  }) as typeof fetch;
}

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
    id: "m-verify-concept2-1",
    channelId: SEED_CHANNELS.morningRow,
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
    opts.habitId ?? "morning-row",
    opts.fireDate ?? FIRE_DATE,
    opts.firedAt ?? Date.parse("2026-05-12T09:05:00.000Z"),
    opts.currentLevel,
    null,
    "pending",
    null,
    null,
    null,
    0,
  );
}

function makeConcept2FetchMock(rows: readonly Concept2Result[]): typeof fetch {
  return makeFetchMock([{ ok: true, body: { data: rows, links: { next: null } } }]);
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

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

describe("makeVerifyConcept2OrPhoto() — Concept2 happy path", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-verify-c2-"));
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

  it("returns completed when Concept2 sync yields a 12-min rower session at L1", async () => {
    seedRun(db, { currentLevel: 1 });

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeConcept2FetchMock([ROWER_12MIN]),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      message: makeMessage(),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("completed");
    const payload = result.proofPayload as {
      source: string;
      session: Concept2Result;
    };
    expect(payload.source).toBe("concept2");
    expect(payload.session).toEqual(ROWER_12MIN);
  });

  it("returns completed with the qualifying session when multiple sessions are present", async () => {
    seedRun(db, { currentLevel: 1 });

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      // Order: two short, one qualifying. The sub-verb must surface the
      // qualifying one rather than the first non-qualifying row.
      fetchImpl: makeConcept2FetchMock([ROWER_4MIN, ROWER_5MIN, ROWER_11MIN]),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      message: makeMessage(),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("completed");
    const payload = result.proofPayload as {
      source: string;
      session: Concept2Result;
    };
    expect(payload.source).toBe("concept2");
    expect(payload.session).toEqual(ROWER_11MIN);
  });
});

describe("makeVerifyConcept2OrPhoto() — pending paths (no claim made)", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-verify-c2-"));
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

  it("returns pending when Concept2 is empty and current_level < fallback_required_at_level", async () => {
    seedRun(db, { currentLevel: 2 }); // < 3

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeConcept2FetchMock([]),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      // Photo present but level too low — fallback must NOT fire.
      message: makeMessage([
        { url: "https://cdn.discordapp.com/img.png", contentType: "image/png" },
      ]),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("pending");
    expect(result.proofPayload).toBeUndefined();
  });

  it("returns pending when only short Concept2 sessions are present and L < fallback", async () => {
    seedRun(db, { currentLevel: 1 });

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeConcept2FetchMock([ROWER_5MIN]),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      message: makeMessage(),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("pending");
  });

  it("returns pending when Concept2 is empty AND level>=fallback BUT no image attachment is present", async () => {
    seedRun(db, { currentLevel: 3 });

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeConcept2FetchMock([]),
      // No vision dispatch — proves we never even tried to call it.
      visionDispatchImpl: makeVisionDispatchMockThrowing(
        new Error("vision should not be called when no attachment"),
      ),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      // Empty attachments — caller is just typing.
      message: makeMessage(),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("pending");
  });

  it("returns pending when Concept2 is empty AND level>=fallback AND attachment is NOT an image", async () => {
    seedRun(db, { currentLevel: 3 });

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeConcept2FetchMock([]),
      visionDispatchImpl: makeVisionDispatchMockThrowing(
        new Error("vision should not be called for non-image attachment"),
      ),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      message: makeMessage([
        { url: "https://cdn.discordapp.com/file.pdf", contentType: "application/pdf" },
      ]),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("pending");
  });
});

describe("makeVerifyConcept2OrPhoto() — photo fallback (level>=3)", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-verify-c2-"));
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

  it("returns completed via vision when Concept2 is empty and a valid PM5 photo is attached at L3", async () => {
    seedRun(db, { currentLevel: 3 });

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeConcept2FetchMock([]),
      visionDispatchImpl: makeVisionDispatchMock({
        structured_output: {
          is_pm5: true,
          duration_minutes: 12,
          meters: 2143,
          completed: true,
          confidence: 0.95,
        },
      }),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      message: makeMessage([
        {
          url: "https://cdn.discordapp.com/pm5.png",
          contentType: "image/png",
        },
      ]),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("completed");
    const payload = result.proofPayload as {
      source: string;
      parsed: { is_pm5: boolean; duration_minutes: number };
    };
    expect(payload.source).toBe("photo");
    expect(payload.parsed.is_pm5).toBe(true);
    expect(payload.parsed.duration_minutes).toBe(12);
  });

  it("returns rejected with a /PM5/-mentioning reason when the photo is not a PM5 screen", async () => {
    seedRun(db, { currentLevel: 4 });

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeConcept2FetchMock([]),
      visionDispatchImpl: makeVisionDispatchMock({
        structured_output: {
          is_pm5: false,
          duration_minutes: 0,
          meters: 0,
          completed: false,
          confidence: 0.2,
        },
      }),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      message: makeMessage([
        { url: "https://cdn.discordapp.com/cat.jpg", contentType: "image/jpeg" },
      ]),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("rejected");
    expect(result.reason).toMatch(/PM5/i);
    const payload = result.proofPayload as {
      source: string;
      parsed: { is_pm5: boolean };
    };
    expect(payload.source).toBe("photo");
    expect(payload.parsed.is_pm5).toBe(false);
  });

  it("returns rejected with a /duration/-mentioning reason when the photo shows an 8-min session", async () => {
    seedRun(db, { currentLevel: 3 });

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeConcept2FetchMock([]),
      visionDispatchImpl: makeVisionDispatchMock({
        structured_output: {
          is_pm5: true,
          duration_minutes: 8,
          meters: 1400,
          completed: true,
          confidence: 0.9,
        },
      }),
    });

    const result = await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      message: makeMessage([
        { url: "https://cdn.discordapp.com/short.jpg", contentType: "image/jpeg" },
      ]),
      now: NOW_MS,
    });

    expect(result.outcome).toBe("rejected");
    expect(result.reason?.toLowerCase()).toMatch(/duration|min/);
  });
});

describe("makeVerifyConcept2OrPhoto() — error propagation", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-verify-c2-"));
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

  it("propagates Concept2 sync errors (caller handles unresolved-status path)", async () => {
    seedRun(db, { currentLevel: 3 });

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeFetchMockThrowing(new Error("network down")),
    });

    await expect(
      subVerb({
        sessionStore,
        sessionId: SESSION_ID,
        habitId: "morning-row",
        runId: RUN_ID,
        message: makeMessage(),
        now: NOW_MS,
      }),
    ).rejects.toThrow(/network down/);
  });

  it("propagates vision dispatch errors", async () => {
    seedRun(db, { currentLevel: 3 });

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeConcept2FetchMock([]),
      visionDispatchImpl: makeVisionDispatchMockThrowing(
        new Error("vision dispatch crashed"),
      ),
    });

    await expect(
      subVerb({
        sessionStore,
        sessionId: SESSION_ID,
        habitId: "morning-row",
        runId: RUN_ID,
        message: makeMessage([
          {
            url: "https://cdn.discordapp.com/pm5.png",
            contentType: "image/png",
          },
        ]),
        now: NOW_MS,
      }),
    ).rejects.toThrow(/vision dispatch crashed/);
  });

  it("throws when habit row is missing (defensive)", async () => {
    seedRun(db, { currentLevel: 1, habitId: "morning-row" });

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeConcept2FetchMock([]),
    });

    await expect(
      subVerb({
        sessionStore,
        sessionId: SESSION_ID,
        habitId: "nonexistent-habit",
        runId: RUN_ID,
        message: makeMessage(),
        now: NOW_MS,
      }),
    ).rejects.toThrow(/nonexistent-habit/);
  });

  it("throws when habit_run row is missing (defensive)", async () => {
    // No seedRun call — habit_runs table empty.

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeConcept2FetchMock([]),
    });

    await expect(
      subVerb({
        sessionStore,
        sessionId: SESSION_ID,
        habitId: "morning-row",
        runId: "missing-run-id",
        message: makeMessage(),
        now: NOW_MS,
      }),
    ).rejects.toThrow(/missing-run-id/);
  });
});

describe("makeVerifyConcept2OrPhoto() — sensor_signals caching", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-verify-c2-"));
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

  it("syncs Concept2 results into sensor_signals (idempotent cache)", async () => {
    seedRun(db, { currentLevel: 1 });

    const subVerb = makeVerifyConcept2OrPhoto({
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: makeConcept2FetchMock([ROWER_12MIN]),
    });

    await subVerb({
      sessionStore,
      sessionId: SESSION_ID,
      habitId: "morning-row",
      runId: RUN_ID,
      message: makeMessage(),
      now: NOW_MS,
    });

    const row = db
      .prepare(
        "SELECT id, source, payload_date FROM sensor_signals WHERE source = 'concept2' AND payload_date = ?",
      )
      .get(FIRE_DATE) as
      | { id: string; source: string; payload_date: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.id).toBe(`concept2-${FIRE_DATE}`);
  });
});
