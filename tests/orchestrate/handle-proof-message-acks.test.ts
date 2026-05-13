// Phase 3: source-channel acks for completed/rejected/pending outcomes.
//
// `handleProofMessage` (src/orchestrate/handle-proof-message.ts) routes an
// inbound Discord message through verify-proof and then posts a source-channel
// ack on every terminal outcome:
//
//   - completed: existing #wins post + new source-channel "Got it — see #wins."
//   - rejected:  existing recordVisionRejection() + new source-channel post
//                that includes the verifier's reason
//   - pending:   new source-channel post tailored to habit.proof_type
//
// These tests drive `handleProofMessage` end-to-end with a stubbed Discord
// adapter (channels.fetch returns a fake text-based channel whose .send is a
// vi.fn) so each outcome's posts can be observed without touching a real
// gateway. Concept2 sync is driven via the injected fetch mock; vision dispatch
// is mocked per-test.
//
// References:
//   - Phase 3 plan: source-channel acknowledgments
//   - tests/orchestrate/verify-proof-concept2.test.ts (fixture conventions)
//   - tests/orchestrate/wins-poster.test.ts (adapter mocking pattern)

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
import type {
  Concept2Credentials,
  Concept2Result,
  Concept2Tokens,
} from "../../src/lib/concept2-adapter.js";
import type { DispatchResult } from "../../src/lib/vision-verify.js";
import { handleProofMessage } from "../../src/orchestrate/handle-proof-message.js";

// -----------------------------------------------------------------------------
// Fixtures.
// -----------------------------------------------------------------------------

const SEED_CHANNELS = {
  morningRow: "1000000000000000001",
  strength: "1000000000000000002",
  windDown: "1000000000000000003",
} as const;

const ALL_CHANNEL_IDS: DiscordChannelIds = {
  "morning-row": SEED_CHANNELS.morningRow,
  strength: SEED_CHANNELS.strength,
  "wind-down": SEED_CHANNELS.windDown,
  wins: "1000000000000000004",
  "sunday-review": "1000000000000000005",
};

const SESSION_ID = "session-handle-proof-acks";
const RUN_ID_ROW = "run-handle-proof-row";
const RUN_ID_WIND = "run-handle-proof-wind";
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
// Mock helpers.
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

function makeConcept2FetchMock(rows: readonly Concept2Result[]): typeof fetch {
  return makeFetchMock([
    { ok: true, body: { data: rows, links: { next: null } } },
  ]);
}

function makeVisionDispatchMock(
  result: DispatchResult,
): (opts: { prompt: string; jsonSchema: string }) => Promise<DispatchResult> {
  return async () => result;
}

function makeVisionDispatchRejection(): (opts: {
  prompt: string;
  jsonSchema: string;
}) => Promise<DispatchResult> {
  // Vision returns "not a PM5 screen" — verify-proof translates to outcome
  // 'rejected' with a /PM5/-mentioning reason (see verify-proof.ts).
  return makeVisionDispatchMock({
    structured_output: {
      is_pm5: false,
      duration_minutes: 0,
      meters: 0,
      completed: false,
      confidence: 0.2,
    },
  });
}

// Replaces `globalThis.fetch` so the Concept2 adapter (which reaches for
// `fetch` directly) hits the canned response. The adapter exposes no
// fetch-impl seam at the verb level, so a global swap is the established
// pattern. Restore via the returned function.
function installGlobalFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
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
    id: "m-handle-proof-1",
    channelId: opts.channelId,
    content: opts.content ?? "",
    author: { bot: false },
    attachments: map,
  } as unknown as Message;
}

interface AdapterHarness {
  readonly adapter: DiscordAdapter;
  readonly send: ReturnType<typeof vi.fn>;
  // Captures (channelId, content) pairs for every successful send call.
  readonly posts: Array<{ channelId: string; content: string }>;
}

// Build an adapter whose channels.fetch returns a fake text channel routing
// every .send back into `posts`. The fake channel records the channelId it
// was looked up by so per-post assertions can verify routing to source vs
// #wins.
function buildAdapter(): AdapterHarness {
  const posts: Array<{ channelId: string; content: string }> = [];
  const send = vi.fn();

  const fetchChannel = vi.fn((channelId: string) => {
    return Promise.resolve({
      isTextBased: () => true,
      send: async (payload: { content: string }) => {
        posts.push({ channelId, content: payload.content });
        send(channelId, payload.content);
        return { id: `msg-${posts.length}` };
      },
    });
  });

  const mockClient = {
    channels: { fetch: fetchChannel },
  };

  const adapter = createDiscordAdapter({
    botToken: "test-bot-token",
    channelIds: ALL_CHANNEL_IDS,
    clientFactory: () => mockClient as unknown as Client,
  });

  return { adapter, send, posts };
}

function seedRowRun(
  db: Database.Database,
  currentLevel: number,
  runId: string = RUN_ID_ROW,
): ActiveHabitRun {
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    "morning-row",
    FIRE_DATE,
    FIRED_AT,
    currentLevel,
    null,
    "pending",
    null,
    null,
    null,
    0,
  );
  return {
    id: runId,
    habit_id: "morning-row",
    fire_date: FIRE_DATE,
    current_level: currentLevel,
    status: "pending",
    proof_rejection_callout_due: 0,
  };
}

function seedWindDownRun(
  db: Database.Database,
  currentLevel: number = 1,
): ActiveHabitRun {
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    RUN_ID_WIND,
    "wind-down",
    FIRE_DATE,
    FIRED_AT,
    currentLevel,
    null,
    "pending",
    null,
    null,
    null,
    0,
  );
  return {
    id: RUN_ID_WIND,
    habit_id: "wind-down",
    fire_date: FIRE_DATE,
    current_level: currentLevel,
    status: "pending",
    proof_rejection_callout_due: 0,
  };
}

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

describe("handleProofMessage() source-channel acks", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;
  let restoreFetch: (() => void) | null;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-handle-proof-ack-"));
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

  it("completed → dual post: source-channel ack + #wins post", async () => {
    const run = seedRowRun(db, 1);
    restoreFetch = installGlobalFetch(makeConcept2FetchMock([ROWER_12MIN]));
    const harness = buildAdapter();

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

    // Exactly two posts: #wins (existing behavior) + source-channel ack (new).
    expect(harness.posts.length).toBe(2);

    const winsPost = harness.posts.find(
      (p) => p.channelId === ALL_CHANNEL_IDS.wins,
    );
    const sourcePost = harness.posts.find(
      (p) => p.channelId === SEED_CHANNELS.morningRow,
    );

    expect(winsPost).toBeDefined();
    expect(winsPost?.content).toMatch(/Morning row/);

    expect(sourcePost).toBeDefined();
    expect(sourcePost?.content).toBe("Got it — see #wins. ✓");
  });

  it("rejected → source-channel post that includes the verifier reason", async () => {
    const run = seedRowRun(db, 3); // L>=3 so vision fallback fires
    restoreFetch = installGlobalFetch(makeConcept2FetchMock([]));
    const harness = buildAdapter();

    await handleProofMessage({
      sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      run,
      message: makeMessage({
        channelId: SEED_CHANNELS.morningRow,
        attachments: [
          {
            url: "https://cdn.discordapp.com/cat.jpg",
            contentType: "image/jpeg",
          },
        ],
      }),
      channelName: "morning-row",
      now: NOW_MS,
      concept2: {
        credentials: VALID_CREDS,
        tokens: VALID_TOKENS,
        onTokensRefreshed: () => {},
      },
      visionDispatchImpl: makeVisionDispatchRejection(),
    });

    // Rejected path posts only the source-channel ack (no #wins).
    const sourcePosts = harness.posts.filter(
      (p) => p.channelId === SEED_CHANNELS.morningRow,
    );
    const winsPosts = harness.posts.filter(
      (p) => p.channelId === ALL_CHANNEL_IDS.wins,
    );
    expect(winsPosts.length).toBe(0);
    expect(sourcePosts.length).toBe(1);

    const ack = sourcePosts[0]!.content;
    expect(ack).toMatch(/doesn't look right/);
    expect(ack).toMatch(/PM5/i); // verify-proof's rejection reason mentions PM5
    expect(ack).toMatch(/Try again\?/);
  });

  it("pending (morning-row) → source-channel ack tailored to concept2_api+photo_fallback", async () => {
    const run = seedRowRun(db, 2); // L<3 so no fallback
    restoreFetch = installGlobalFetch(makeConcept2FetchMock([])); // no qualifying rows
    const harness = buildAdapter();

    await handleProofMessage({
      sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      run,
      // No attachment, just a typed message — pending outcome.
      message: makeMessage({
        channelId: SEED_CHANNELS.morningRow,
        content: "doing it now",
      }),
      channelName: "morning-row",
      now: NOW_MS,
      concept2: {
        credentials: VALID_CREDS,
        tokens: VALID_TOKENS,
        onTokensRefreshed: () => {},
      },
      visionDispatchImpl: async () => ({ error: "should not be called" }),
    });

    expect(harness.posts.length).toBe(1);
    const ack = harness.posts[0]!;
    expect(ack.channelId).toBe(SEED_CHANNELS.morningRow);
    expect(ack.content).toMatch(/I see your message/);
    expect(ack.content).toMatch(/PM5/);
  });

  it("pending (wind-down) → source-channel ack tailored to typed_msg+garmin_sleep (different text than morning-row)", async () => {
    const run = seedWindDownRun(db, 1);
    const harness = buildAdapter();

    await handleProofMessage({
      sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      run,
      // No trigger phrase, no garmin → pending. The wind-down sub-verb path
      // currently returns 'pending' (or 'pending' with a reason) when stage A
      // doesn't fire.
      message: makeMessage({
        channelId: SEED_CHANNELS.windDown,
        content: "thinking about bed",
      }),
      channelName: "wind-down",
      now: NOW_MS,
      concept2: null,
      visionDispatchImpl: async () => ({ error: "should not be called" }),
    });

    expect(harness.posts.length).toBe(1);
    const ack = harness.posts[0]!;
    expect(ack.channelId).toBe(SEED_CHANNELS.windDown);
    expect(ack.content).toMatch(/I see your message/);
    expect(ack.content).toMatch(/shutting down|Garmin/i);
    // Distinct from morning-row's PM5 text.
    expect(ack.content).not.toMatch(/PM5/);
  });

  it("completed-ack post fires when buildCompletionForHabit returns null (no #wins post by design)", async () => {
    // Insert a custom habit with proof_type = concept2_api+photo_fallback so
    // the verifier path works, but with an id that buildCompletionForHabit's
    // switch falls through to `default: return null` for. The seed config
    // for morning-row is reused as the config_json.
    const morningRowConfig = db
      .prepare("SELECT proof_config_json FROM habits WHERE id = 'morning-row'")
      .get() as { proof_config_json: string };
    db.prepare(
      `INSERT INTO habits (
         id, name, domain, cron_expr, why_stakes_json, proof_type,
         proof_config_json, channel_id, active, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "custom-row",
      "Custom row",
      "row",
      "5 9 * * *",
      "{}",
      "concept2_api+photo_fallback",
      morningRowConfig.proof_config_json,
      SEED_CHANNELS.morningRow,
      1,
      Date.now(),
    );

    db.prepare(
      `INSERT INTO habit_runs (
         id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
         status, completed_at, proof_payload_json, skip_reason,
         proof_rejection_callout_due
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-custom-row",
      "custom-row",
      FIRE_DATE,
      FIRED_AT,
      1,
      null,
      "pending",
      null,
      null,
      null,
      0,
    );

    const run: ActiveHabitRun = {
      id: "run-custom-row",
      habit_id: "custom-row",
      fire_date: FIRE_DATE,
      current_level: 1,
      status: "pending",
      proof_rejection_callout_due: 0,
    };

    restoreFetch = installGlobalFetch(makeConcept2FetchMock([ROWER_12MIN]));
    const harness = buildAdapter();

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

    // No #wins post (buildCompletionForHabit returned null for 'custom-row')
    // but the source-channel ack still fires.
    const winsPosts = harness.posts.filter(
      (p) => p.channelId === ALL_CHANNEL_IDS.wins,
    );
    const sourcePosts = harness.posts.filter(
      (p) => p.channelId === SEED_CHANNELS.morningRow,
    );
    expect(winsPosts.length).toBe(0);
    expect(sourcePosts.length).toBe(1);
    expect(sourcePosts[0]!.content).toBe("Got it — see #wins. ✓");
  });
});
