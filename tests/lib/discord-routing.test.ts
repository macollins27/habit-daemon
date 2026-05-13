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
}

function makeMessage(opts: FakeMessageOptions): Message {
  return {
    id: "m-" + randomUUID(),
    channelId: opts.channelId,
    content: opts.content ?? "hello bot",
    author: { bot: opts.bot ?? false },
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

    h.mockClient.emit(makeMessage({ channelId: CH_MORNING_ROW, content: "done!" }));

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
