// Phase 6: track-and-follow-up on superseded escalations.
//
// When an escalation message is posted by runHabitCheckin, the run's
// last_escalation_message_id is recorded. Three autonomous-close paths then
// post a brief follow-up ("✓ Proof is in — see #wins.") to the source channel
// before the standard closure summary so the orphaned escalation gets closure:
//
//   1. runHabitCheckin (capture only — no follow-up; that's path 3a).
//   2. reconcile-pending-runs.
//   3. runHabitCheckin's short-circuit branch (checkProvable in-tick).
//   4. handle-proof-message's applyCompleted (proof posted by user). The
//      follow-up REPLACES the standard "Got it — see #wins. ✓" ack when an
//      escalation is in play; otherwise the standard ack fires.
//
// References:
//   - Phase 6 of docs/plans/2026-05-12-habit-daemon-remediation-plan.md
//   - src/orchestrate/habit-checkin.ts (ESCALATION_FOLLOW_UP_CONTENT)
//   - src/orchestrate/reconcile-pending-runs.ts (postDualChannel)
//   - src/orchestrate/handle-proof-message.ts (applyCompleted ack)

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
  type ActiveHabitRun,
  type DiscordAdapter,
  type DiscordChannelIds,
} from "../../src/lib/discord-adapter.js";
import {
  runHabitCheckin,
  ESCALATION_FOLLOW_UP_CONTENT,
} from "../../src/orchestrate/habit-checkin.js";
import { reconcilePendingRuns } from "../../src/orchestrate/reconcile-pending-runs.js";
import { handleProofMessage } from "../../src/orchestrate/handle-proof-message.js";
import type {
  Concept2Credentials,
  Concept2Result,
  Concept2Tokens,
} from "../../src/lib/concept2-adapter.js";

// -----------------------------------------------------------------------------
// Fixtures.
// -----------------------------------------------------------------------------

const CHANNEL_IDS: DiscordChannelIds = {
  "morning-row": "1000000000000000001",
  strength: "1000000000000000002",
  "wind-down": "1000000000000000003",
  wins: "1000000000000000004",
  "sunday-review": "1000000000000000005",
};

const SEED_CHANNELS = {
  morningRow: CHANNEL_IDS["morning-row"],
  strength: CHANNEL_IDS.strength,
  windDown: CHANNEL_IDS["wind-down"],
} as const;

const SESSION_ID = "session-test-escalation-followup";
const FIRE_DATE = "2026-05-12";
const NOW_MS = Date.parse("2026-05-12T09:35:00.000Z");
const FIRED_AT = Date.parse("2026-05-12T09:05:00.000Z");

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

const ROWER_12MIN: Concept2Result = {
  id: 201,
  date: "2026-05-12 09:15:00",
  type: "rower",
  duration_seconds: 720,
  distance_meters: 2143,
};

// -----------------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------------

interface SeedRunOpts {
  readonly runId: string;
  readonly habitId: string;
  readonly currentLevel?: number;
  readonly status?: string;
  readonly fireDate?: string;
  readonly lastEscalationMessageId?: string | null;
}

function seedHabitRun(db: Database.Database, opts: SeedRunOpts): void {
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due, last_escalation_message_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId,
    opts.habitId,
    opts.fireDate ?? FIRE_DATE,
    FIRED_AT,
    opts.currentLevel ?? 1,
    null,
    opts.status ?? "pending",
    null,
    null,
    null,
    0,
    opts.lastEscalationMessageId ?? null,
  );
}

interface QualifyingSession {
  readonly id: number;
  readonly date: string;
  readonly type: string;
  readonly duration_seconds: number;
  readonly distance_meters: number;
}

function seedQualifyingConcept2(
  db: Database.Database,
  fireDate: string,
): QualifyingSession {
  const session: QualifyingSession = {
    id: 7777,
    date: `${fireDate} 09:35:00`,
    type: "rower",
    duration_seconds: 720,
    distance_meters: 2500,
  };
  db.prepare(
    `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    `concept2-${fireDate}`,
    "concept2",
    fireDate,
    JSON.stringify({ results: [session] }),
    NOW_MS,
  );
  return session;
}

function getLastEscalationMessageId(
  db: Database.Database,
  runId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT last_escalation_message_id FROM habit_runs WHERE id = ?`,
    )
    .get(runId) as
    | { readonly last_escalation_message_id: string | null }
    | undefined;
  return row?.last_escalation_message_id ?? null;
}

// -----------------------------------------------------------------------------
// Discord adapter mock.
// -----------------------------------------------------------------------------

interface AdapterHarness {
  readonly adapter: DiscordAdapter;
  readonly posts: Array<{ channelId: string; content: string }>;
}

function buildAdapter(): AdapterHarness {
  const posts: Array<{ channelId: string; content: string }> = [];

  const fetchChannel = vi.fn((channelId: string) => {
    return Promise.resolve({
      isTextBased: () => true,
      send: async (payload: { content: string }) => {
        posts.push({ channelId, content: payload.content });
        return { id: `msg-${posts.length}` };
      },
    });
  });

  const mockClient = {
    channels: { fetch: fetchChannel },
  };

  const adapter = createDiscordAdapter({
    botToken: "test-bot-token",
    channelIds: CHANNEL_IDS,
    clientFactory: () => mockClient as unknown as Client,
  });

  return { adapter, posts };
}

function happyDispatch(): (opts: {
  prompt: string;
  jsonSchema: string;
}) => Promise<{
  structured_output: { message_text: string; next_check_in_iso: string };
}> {
  return async () => ({
    structured_output: {
      message_text: "Hey — row time. PM5 photo when done.",
      next_check_in_iso: "2026-05-12T10:05:00.000Z",
    },
  });
}

// Mocks `globalThis.fetch` for the Concept2 adapter used by
// handleProofMessage. Returns a single canned response with the supplied
// rows. Mirrors the pattern in handle-proof-message-acks.test.ts.
function installConcept2FetchMock(rows: readonly Concept2Result[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: rows, links: { next: null } }),
      text: async () => JSON.stringify({ data: rows, links: { next: null } }),
    } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

interface AttachmentLike {
  readonly url: string;
  readonly contentType: string | null;
}

function makeMessage(opts: {
  channelId: string;
  content?: string;
  attachments?: readonly AttachmentLike[];
}): Message {
  const map = new Map<string, AttachmentLike>();
  (opts.attachments ?? []).forEach((a, idx) => {
    map.set(`attach-${idx}`, a);
  });
  return {
    id: "m-followup-1",
    channelId: opts.channelId,
    content: opts.content ?? "",
    author: { bot: false },
    attachments: map,
  } as unknown as Message;
}

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

describe("Phase 6: escalation follow-up", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;
  let restoreFetch: (() => void) | null;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-escalation-followup-"));
    dbPath = join(tempDir, "store.db");

    const migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
    seedHabits(migrator, SEED_CHANNELS);
    migrator.close();

    sessionStore = new SessionStore({ dbPath });
    db = sessionStore.db;
    restoreFetch = null;
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(tempDir, { recursive: true, force: true });
    if (restoreFetch !== null) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  // ---------------------------------------------------------------------------
  // 6.1: runHabitCheckin captures the escalation message id.
  // ---------------------------------------------------------------------------

  it("runHabitCheckin captures escalation message id", async () => {
    seedHabitRun(db, { runId: "run-cap-1", habitId: "morning-row" });
    const { adapter } = buildAdapter();
    const postImpl = vi
      .fn()
      .mockResolvedValue({ messageId: "msg-123" });

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-cap-1",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: happyDispatch(),
      postImpl,
    });

    expect(postImpl).toHaveBeenCalledTimes(1);
    expect(getLastEscalationMessageId(db, "run-cap-1")).toBe("msg-123");
  });

  it("runHabitCheckin doesn't capture id when post fails", async () => {
    seedHabitRun(db, { runId: "run-cap-fail", habitId: "morning-row" });
    const { adapter } = buildAdapter();
    const postImpl = vi.fn().mockRejectedValue(new Error("flaky channel"));
    const consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-cap-fail",
        currentLevel: 1,
        now: NOW_MS,
        dispatchImpl: happyDispatch(),
        postImpl,
      }),
    ).rejects.toThrow(/flaky channel/);

    // The post failed BEFORE the UPDATE — so the column stays NULL.
    expect(getLastEscalationMessageId(db, "run-cap-fail")).toBeNull();
    consoleErrSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 6.2a: reconciler follow-up.
  // ---------------------------------------------------------------------------

  it("reconciler posts follow-up when prior escalation is tracked", async () => {
    seedHabitRun(db, {
      runId: "run-rec-with-esc",
      habitId: "morning-row",
      fireDate: "2026-05-13",
      lastEscalationMessageId: "msg-456",
    });
    const fireDate = "2026-05-13";
    seedQualifyingConcept2(db, fireDate);
    const nowMs = Date.parse("2026-05-13T15:00:00Z");

    const posts: Array<{ channelId: string; summary: string }> = [];

    const result = await reconcilePendingRuns({
      sessionStore,
      now: nowMs,
      concept2Sync: async () => {},
      garminSync: async () => {},
      postCompletion: async (o) => {
        posts.push({ channelId: o.channelId, summary: o.summary });
      },
    });

    expect(result.attempted).toBe(1);
    expect(result.completed).toBe(1);

    // Three posts: follow-up to source, summary to source, summary to #wins.
    expect(posts).toHaveLength(3);
    expect(posts[0]).toEqual({
      channelId: SEED_CHANNELS.morningRow,
      summary: ESCALATION_FOLLOW_UP_CONTENT,
    });
    expect(posts[1]?.channelId).toBe(SEED_CHANNELS.morningRow);
    expect(posts[1]?.summary).toMatch(/Morning row/);
    expect(posts[2]?.channelId).toBe("wins");
    expect(posts[2]?.summary).toMatch(/Morning row/);
  });

  it("reconciler skips follow-up when no escalation tracked", async () => {
    seedHabitRun(db, {
      runId: "run-rec-no-esc",
      habitId: "morning-row",
      fireDate: "2026-05-13",
      lastEscalationMessageId: null,
    });
    const fireDate = "2026-05-13";
    seedQualifyingConcept2(db, fireDate);
    const nowMs = Date.parse("2026-05-13T15:00:00Z");

    const posts: Array<{ channelId: string; summary: string }> = [];

    const result = await reconcilePendingRuns({
      sessionStore,
      now: nowMs,
      concept2Sync: async () => {},
      garminSync: async () => {},
      postCompletion: async (o) => {
        posts.push({ channelId: o.channelId, summary: o.summary });
      },
    });

    expect(result.completed).toBe(1);
    // Standard two posts: summary to source + #wins. No follow-up.
    expect(posts).toHaveLength(2);
    expect(posts.find((p) => p.summary === ESCALATION_FOLLOW_UP_CONTENT)).toBeUndefined();
    expect(posts[0]?.summary).toMatch(/Morning row/);
    expect(posts[1]?.summary).toMatch(/Morning row/);
  });

  // ---------------------------------------------------------------------------
  // 6.2b: habit-checkin short-circuit follow-up.
  // ---------------------------------------------------------------------------

  it("habit-checkin short-circuit posts follow-up when escalation tracked", async () => {
    seedHabitRun(db, {
      runId: "run-sc-with-esc",
      habitId: "morning-row",
      currentLevel: 2,
      lastEscalationMessageId: "msg-from-l1",
    });
    seedQualifyingConcept2(db, FIRE_DATE);

    const { adapter, posts } = buildAdapter();
    const dispatchImpl = vi
      .fn()
      .mockRejectedValue(new Error("dispatch must not run"));
    const postImpl = vi
      .fn()
      .mockRejectedValue(new Error("post must not run"));

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-sc-with-esc",
      currentLevel: 2,
      now: NOW_MS,
      dispatchImpl,
      postImpl,
    });

    // Three posts: follow-up to source, summary to source, summary to #wins.
    expect(posts).toHaveLength(3);
    expect(posts[0]).toEqual({
      channelId: SEED_CHANNELS.morningRow,
      content: ESCALATION_FOLLOW_UP_CONTENT,
    });
    expect(posts[1]?.channelId).toBe(SEED_CHANNELS.morningRow);
    expect(posts[1]?.content).toMatch(/Morning row/);
    expect(posts[2]?.channelId).toBe(CHANNEL_IDS.wins);
    expect(posts[2]?.content).toMatch(/Morning row/);
  });

  it("habit-checkin short-circuit skips follow-up when no escalation tracked", async () => {
    // Symmetric pin: when last_escalation_message_id is NULL, the short-circuit
    // must post only the standard dual-channel summary (2 posts), NOT the
    // follow-up. Prevents a regression where the source-channel post double-
    // posts (follow-up + summary) on first-tick wins.
    seedHabitRun(db, {
      runId: "run-sc-no-esc",
      habitId: "morning-row",
      currentLevel: 2,
      lastEscalationMessageId: null,
    });
    seedQualifyingConcept2(db, FIRE_DATE);

    const { adapter, posts } = buildAdapter();
    const dispatchImpl = vi
      .fn()
      .mockRejectedValue(new Error("dispatch must not run"));
    const postImpl = vi
      .fn()
      .mockRejectedValue(new Error("post must not run"));

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-sc-no-esc",
      currentLevel: 2,
      now: NOW_MS,
      dispatchImpl,
      postImpl,
    });

    // Exactly 2 posts (source summary + wins summary). No follow-up.
    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p.content !== ESCALATION_FOLLOW_UP_CONTENT)).toBe(true);
    expect(posts.every((p) => /Morning row/.test(p.content))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 6.2c: handle-proof-message — follow-up REPLACES standard ack.
  // ---------------------------------------------------------------------------

  it("handle-proof-message replaces the ack with follow-up when escalation tracked", async () => {
    seedHabitRun(db, {
      runId: "run-hpm-with-esc",
      habitId: "morning-row",
      currentLevel: 3,
      lastEscalationMessageId: "msg-xyz",
    });
    restoreFetch = installConcept2FetchMock([ROWER_12MIN]);
    const harness = buildAdapter();

    const run: ActiveHabitRun = {
      id: "run-hpm-with-esc",
      habit_id: "morning-row",
      fire_date: FIRE_DATE,
      current_level: 3,
      status: "pending",
      proof_rejection_callout_due: 0,
    };

    await handleProofMessage({
      sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      run,
      message: makeMessage({ channelId: SEED_CHANNELS.morningRow }),
      channelName: "morning-row",
      now: NOW_MS,
      concept2: {
        credentials: VALID_CREDS,
        tokens: VALID_TOKENS,
        onTokensRefreshed: () => {},
      },
      visionDispatchImpl: async () => ({ error: "should not be called" }),
    });

    const sourcePosts = harness.posts.filter(
      (p) => p.channelId === SEED_CHANNELS.morningRow,
    );
    expect(sourcePosts).toHaveLength(1);
    expect(sourcePosts[0]?.content).toBe(ESCALATION_FOLLOW_UP_CONTENT);
    // Sanity: the standard ack must NOT appear.
    expect(
      harness.posts.find((p) => p.content === "Got it — see #wins. ✓"),
    ).toBeUndefined();
  });

  it("handle-proof-message posts standard ack when no escalation tracked", async () => {
    seedHabitRun(db, {
      runId: "run-hpm-no-esc",
      habitId: "morning-row",
      currentLevel: 1,
      lastEscalationMessageId: null,
    });
    restoreFetch = installConcept2FetchMock([ROWER_12MIN]);
    const harness = buildAdapter();

    const run: ActiveHabitRun = {
      id: "run-hpm-no-esc",
      habit_id: "morning-row",
      fire_date: FIRE_DATE,
      current_level: 1,
      status: "pending",
      proof_rejection_callout_due: 0,
    };

    await handleProofMessage({
      sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      run,
      message: makeMessage({ channelId: SEED_CHANNELS.morningRow }),
      channelName: "morning-row",
      now: NOW_MS,
      concept2: {
        credentials: VALID_CREDS,
        tokens: VALID_TOKENS,
        onTokensRefreshed: () => {},
      },
      visionDispatchImpl: async () => ({ error: "should not be called" }),
    });

    const sourcePosts = harness.posts.filter(
      (p) => p.channelId === SEED_CHANNELS.morningRow,
    );
    expect(sourcePosts).toHaveLength(1);
    expect(sourcePosts[0]?.content).toBe("Got it — see #wins. ✓");
    // Sanity: the follow-up text must NOT appear.
    expect(
      harness.posts.find((p) => p.content === ESCALATION_FOLLOW_UP_CONTENT),
    ).toBeUndefined();
  });
});
