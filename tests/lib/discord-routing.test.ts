// Phase 4 / Task 4.4: Discord listener chat fall-through routing.
//
// Verifies the new `chatHandler` option on `subscribeMessages`:
//
//   - Active channel + no matching run + chatHandler provided
//     -> chatHandler invoked (with channelId, channelName, text, message).
//   - Active channel + no matching run + NO chatHandler
//     -> still skipped (backward compat — prior listener behaviour).
//   - Active channel + matching run
//     -> proof handler invoked, chatHandler NOT invoked.
//   - Bot-author message
//     -> neither handler invoked.
//   - Non-active channel (wins, sunday-review)
//     -> neither handler invoked.
//
// Mirrors the mocking style of tests/lib/discord-listener.test.ts: structural
// client mock + in-memory SQLite with real migrations + seed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Client, Message } from "discord.js";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import {
  createDiscordAdapter,
  subscribeMessages,
  type ChatFallthroughArgs,
  type DiscordAdapter,
  type DiscordChannelIds,
  type MessageMatch,
} from "../../src/lib/discord-adapter.js";

const CH_MORNING_ROW = "1000000000000000001";
const CH_STRENGTH = "1000000000000000002";
const CH_WIND_DOWN = "1000000000000000003";
const CH_WINS = "1000000000000000004";
const CH_SUNDAY_REVIEW = "1000000000000000005";

function validChannelIds(): DiscordChannelIds {
  return {
    "morning-row": CH_MORNING_ROW,
    strength: CH_STRENGTH,
    "wind-down": CH_WIND_DOWN,
    wins: CH_WINS,
    "sunday-review": CH_SUNDAY_REVIEW,
  };
}

interface MockClient {
  readonly on: ReturnType<typeof vi.fn>;
  readonly off: ReturnType<typeof vi.fn>;
  emit: (msg: Message) => void;
}

function makeMockClient(): MockClient {
  const state: { handler: ((msg: Message) => unknown) | undefined } = {
    handler: undefined,
  };
  const onFn = vi.fn((event: string, h: (msg: Message) => unknown) => {
    if (event === "messageCreate") state.handler = h;
  });
  const offFn = vi.fn((event: string, h: (msg: Message) => unknown) => {
    if (event === "messageCreate" && state.handler === h) state.handler = undefined;
  });
  return {
    on: onFn,
    off: offFn,
    emit: (msg: Message) => {
      if (state.handler) state.handler(msg);
    },
  } as unknown as MockClient;
}

interface FakeMessageOptions {
  readonly channelId: string;
  readonly bot?: boolean;
  readonly content?: string;
  /** Sets attachments.size = 1 (or 0) so the pre-filter sees a photo. */
  readonly hasAttachment?: boolean;
}

function makeMessage(opts: FakeMessageOptions): Message {
  const size = opts.hasAttachment ? 1 : 0;
  return {
    id: "m-" + randomUUID(),
    channelId: opts.channelId,
    content: opts.content ?? "hello bot",
    author: { bot: opts.bot ?? false },
    attachments: { size },
  } as unknown as Message;
}

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function seedPendingRun(
  db: Database.Database,
  habitId: string,
  fireDate: string,
): string {
  const id = "run-" + randomUUID();
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, 1, NULL, 'pending', NULL, NULL, NULL, 0)`,
  ).run(id, habitId, fireDate, Date.now());
  return id;
}

interface Harness {
  readonly db: Database.Database;
  readonly adapter: DiscordAdapter;
  readonly mockClient: MockClient;
  readonly now: Date;
}

async function buildHarness(now: Date = new Date("2026-05-13T10:30:00")): Promise<Harness> {
  const db = openDatabase(":memory:");
  await runMigrations(db, loadMigrations());
  seedHabits(db, {
    morningRow: CH_MORNING_ROW,
    strength: CH_STRENGTH,
    windDown: CH_WIND_DOWN,
  });
  const mockClient = makeMockClient();
  const adapter = createDiscordAdapter({
    botToken: "test-bot-token",
    channelIds: validChannelIds(),
    clientFactory: () => mockClient as unknown as Client,
  });
  return { db, adapter, mockClient, now };
}

describe("subscribeMessages chat fall-through", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  it("invokes chatHandler when an active-channel message has no matching pending run", async () => {
    const proofHandler = vi.fn();
    const chatHandler = vi.fn();

    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler: proofHandler,
      chatHandler,
      now: () => h.now,
    });

    h.mockClient.emit(
      makeMessage({ channelId: CH_MORNING_ROW, content: "did I row today?" }),
    );

    expect(proofHandler).not.toHaveBeenCalled();
    expect(chatHandler).toHaveBeenCalledTimes(1);
    const args = chatHandler.mock.calls[0]![0] as ChatFallthroughArgs;
    expect(args.channelId).toBe(CH_MORNING_ROW);
    expect(args.channelName).toBe("morning-row");
    expect(args.text).toBe("did I row today?");
    expect(args.message).toBeDefined();
  });

  it("preserves prior behaviour (silent skip) when chatHandler is NOT provided", async () => {
    const proofHandler = vi.fn();

    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler: proofHandler,
      now: () => h.now,
    });

    h.mockClient.emit(makeMessage({ channelId: CH_MORNING_ROW, content: "hi" }));

    expect(proofHandler).not.toHaveBeenCalled();
  });

  it("proof handler still wins when an active run matches — chatHandler NOT invoked", async () => {
    seedPendingRun(h.db, "morning-row", localDateString(h.now));

    const proofHandler = vi.fn();
    const chatHandler = vi.fn();

    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler: proofHandler,
      chatHandler,
      now: () => h.now,
    });

    // Pre-filter requires an attachment for the `concept2_api+photo_fallback`
    // proof_type. A pure-text message would (correctly) fall through to chat.
    h.mockClient.emit(
      makeMessage({
        channelId: CH_MORNING_ROW,
        content: "done!",
        hasAttachment: true,
      }),
    );

    expect(proofHandler).toHaveBeenCalledTimes(1);
    expect(chatHandler).not.toHaveBeenCalled();
    const match = proofHandler.mock.calls[0]![0] as MessageMatch;
    expect(match.channelName).toBe("morning-row");
  });

  it("bot-author messages are skipped by BOTH handlers", async () => {
    const proofHandler = vi.fn();
    const chatHandler = vi.fn();

    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler: proofHandler,
      chatHandler,
      now: () => h.now,
    });

    h.mockClient.emit(
      makeMessage({ channelId: CH_MORNING_ROW, bot: true, content: "I am a bot" }),
    );

    expect(proofHandler).not.toHaveBeenCalled();
    expect(chatHandler).not.toHaveBeenCalled();
  });

  it("non-active channels (wins, sunday-review) skip BOTH handlers", async () => {
    const proofHandler = vi.fn();
    const chatHandler = vi.fn();

    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler: proofHandler,
      chatHandler,
      now: () => h.now,
    });

    h.mockClient.emit(makeMessage({ channelId: CH_WINS }));
    h.mockClient.emit(makeMessage({ channelId: CH_SUNDAY_REVIEW }));
    h.mockClient.emit(makeMessage({ channelId: "9999999999999999999" }));

    expect(proofHandler).not.toHaveBeenCalled();
    expect(chatHandler).not.toHaveBeenCalled();
  });

  it("survives a chatHandler async rejection without breaking subsequent messages", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    let callCount = 0;
    const chatHandler = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("first chat boom");
    });
    const proofHandler = vi.fn();

    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler: proofHandler,
      chatHandler,
      now: () => h.now,
    });

    h.mockClient.emit(makeMessage({ channelId: CH_MORNING_ROW, content: "q1" }));
    h.mockClient.emit(makeMessage({ channelId: CH_STRENGTH, content: "q2" }));

    await new Promise((r) => setImmediate(r));

    expect(chatHandler).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Single-channel mode: multiple habits share one Discord channel snowflake.
// The listener must:
//   - look up ALL active runs for that channel (multi-row, not LIMIT 1),
//   - pre-filter by message shape (attachment vs trigger phrase),
//   - route to proof on exactly 1 candidate, otherwise fall through to chat.
//
// To exercise this, we re-seed `habits.channel_id` to a shared snowflake for
// all three active habits after the standard seed runs.
// ---------------------------------------------------------------------------

const CH_SHARED = "1000000000000000099";

function seedRunWithLevel(
  db: Database.Database,
  habitId: string,
  fireDate: string,
  status: "pending" | "partial",
  currentLevel: number,
): string {
  const id = "run-" + randomUUID();
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, 0)`,
  ).run(id, habitId, fireDate, Date.now(), currentLevel, status);
  return id;
}

async function buildSingleChannelHarness(
  now: Date = new Date("2026-05-13T10:30:00"),
): Promise<Harness> {
  const db = openDatabase(":memory:");
  await runMigrations(db, loadMigrations());
  // Seed all three habits with the SAME channel_id — simulating the user's
  // ~/.habit-daemon/env update where DISCORD_CHANNEL_* all point at one
  // #habits channel and habits.channel_id is UPDATEd to match.
  seedHabits(db, {
    morningRow: CH_SHARED,
    strength: CH_SHARED,
    windDown: CH_SHARED,
  });
  const mockClient = makeMockClient();
  const adapter = createDiscordAdapter({
    botToken: "test-bot-token",
    channelIds: {
      "morning-row": CH_SHARED,
      strength: CH_SHARED,
      "wind-down": CH_SHARED,
      wins: CH_SHARED,
      "sunday-review": CH_SHARED,
    },
    clientFactory: () => mockClient as unknown as Client,
  });
  return { db, adapter, mockClient, now };
}

describe("subscribeMessages single-channel mode", () => {
  let h: Harness;

  afterEach(() => {
    h?.db.close();
  });

  it("multi-run lookup with shared channel: plain text falls through to chat (not proof)", async () => {
    h = await buildSingleChannelHarness();
    const today = localDateString(h.now);
    // Two active runs (morning-row + strength) on the SHARED channel today.
    seedRunWithLevel(h.db, "morning-row", today, "pending", 1);
    seedRunWithLevel(h.db, "strength-mwf", today, "pending", 1);

    const proofHandler = vi.fn();
    const chatHandler = vi.fn();

    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler: proofHandler,
      chatHandler,
      now: () => h.now,
    });

    // Plain text, no attachment, no trigger phrase. Neither run's proof_type
    // accepts this shape → candidates = []. Listener must fall through to
    // chat instead of nondeterministically picking one run for proof.
    h.mockClient.emit(
      makeMessage({ channelId: CH_SHARED, content: "hey how's it going" }),
    );

    expect(proofHandler).not.toHaveBeenCalled();
    expect(chatHandler).toHaveBeenCalledTimes(1);
    const args = chatHandler.mock.calls[0]![0] as ChatFallthroughArgs;
    expect(args.channelId).toBe(CH_SHARED);
    expect(args.text).toBe("hey how's it going");
  });

  it("ambiguous-proof: attachment with two photo-accepting runs falls through to chat", async () => {
    h = await buildSingleChannelHarness();
    const today = localDateString(h.now);
    // Both morning-row (concept2_api+photo_fallback) and strength-mwf
    // (training_log_photo) accept an attachment. With both pending on the
    // shared channel, the listener must NOT guess — it falls through to chat.
    seedRunWithLevel(h.db, "morning-row", today, "pending", 1);
    seedRunWithLevel(h.db, "strength-mwf", today, "pending", 1);

    const proofHandler = vi.fn();
    const chatHandler = vi.fn();

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler: proofHandler,
      chatHandler,
      now: () => h.now,
    });

    h.mockClient.emit(
      makeMessage({
        channelId: CH_SHARED,
        content: "here you go",
        hasAttachment: true,
      }),
    );

    expect(proofHandler).not.toHaveBeenCalled();
    expect(chatHandler).toHaveBeenCalledTimes(1);

    // Verify the ambiguous-proof log fires so operators can see why a photo
    // routed to chat (the coach asks "which habit?" conversationally).
    const ambiguousLog = stdoutSpy.mock.calls.some((c) =>
      String(c[0] ?? "").includes("ambiguous-proof: 2 candidates"),
    );
    expect(ambiguousLog).toBe(true);
    stdoutSpy.mockRestore();
  });

  it("filter to single candidate: attachment with one photo run + one phrase-only run routes to proof", async () => {
    h = await buildSingleChannelHarness();
    const today = localDateString(h.now);
    // morning-row accepts photos; wind-down accepts only the typed trigger
    // phrase. An attachment with no phrase narrows to a single candidate
    // (morning-row) and the proof handler MUST fire with that run.
    const morningRowRunId = seedRunWithLevel(
      h.db,
      "morning-row",
      today,
      "pending",
      1,
    );
    seedRunWithLevel(h.db, "wind-down", today, "pending", 1);

    const proofHandler = vi.fn();
    const chatHandler = vi.fn();

    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler: proofHandler,
      chatHandler,
      now: () => h.now,
    });

    h.mockClient.emit(
      makeMessage({
        channelId: CH_SHARED,
        content: "rowed",
        hasAttachment: true,
      }),
    );

    expect(chatHandler).not.toHaveBeenCalled();
    expect(proofHandler).toHaveBeenCalledTimes(1);
    const match = proofHandler.mock.calls[0]![0] as MessageMatch;
    expect(match.run.id).toBe(morningRowRunId);
    expect(match.run.habit_id).toBe("morning-row");
    // The representative channelName should be the one matching the run.
    expect(match.channelName).toBe("morning-row");
  });
});
