// Task 22: Discord listener (incoming + active run match).
//
// `subscribeMessages()` registers a `messageCreate` listener on the discord.js
// Client wired into a `DiscordAdapter` (Task 20). For every non-bot message
// it observes in one of the three *active* channels (morning-row, strength,
// wind-down), it looks up the active `habit_runs` row for that channel's
// habit on today's `fire_date` (status IN ('pending','partial')) and, if
// one is found, hands `{run, message, channelName}` to the caller's handler.
//
// The `wins` and `sunday-review` channels are bot-output-only — the listener
// must not invoke the handler for messages in those channels.
//
// These tests build a structural mock of `client.on` / `client.off` /
// `emit(...)` so we never open a real gateway connection. The database side
// uses the real migrations + seed (in-memory SQLite) so the query under test
// runs against the production schema.
//
// Coverage:
//
//   1. Subscribes via client.on('messageCreate', ...) and unsubscribes via
//      client.off with the same handler reference.
//   2. Bot messages (author.bot === true) skipped.
//   3. Messages in non-active channels (wins, sunday-review, unknown id)
//      skipped.
//   4. Active channel + no habit_runs row for today → handler NOT called.
//   5. Active channel + pending habit_runs row → handler called with the
//      correct {run, message, channelName} mapping.
//   6. Active channel + partial habit_runs row → handler called.
//   7. Completed / missed / skipped habit_runs rows NOT matched.
//   8. Yesterday's fire_date NOT matched (local-time semantics via injected
//      now).
//   9. Async handler that rejects: the listener catches the rejection and
//      remains functional for subsequent messages (no crash).
//  10. Two active channels, two seeded runs: each emission resolves to its
//      own habit_run row.

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
  type ActiveHabitRun,
  type ChannelName,
  type DiscordAdapter,
  type DiscordChannelIds,
  type MessageMatch,
} from "../../src/lib/discord-adapter.js";

// -----------------------------------------------------------------------------
// Channel registry shared between the adapter and the seeded habits.
//
// The listener uses `habits.channel_id` to resolve channel → habit, so the
// adapter's DiscordChannelIds for the three active channels must equal the
// channelIds passed to seedHabits().
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// Minimal mock Client. We only model the three surface points the listener
// touches: .on(event, handler), .off(event, handler), and a test-side
// `emit(msg)` helper that drives whatever handler the listener registered.
// -----------------------------------------------------------------------------
interface MockClient {
  readonly on: ReturnType<typeof vi.fn>;
  readonly off: ReturnType<typeof vi.fn>;
  emit: (msg: Message) => void;
  registeredHandler: ((msg: Message) => unknown) | undefined;
}

function makeMockClient(): MockClient {
  const state: { handler: ((msg: Message) => unknown) | undefined } = {
    handler: undefined,
  };
  const onFn = vi.fn((event: string, handler: (msg: Message) => unknown) => {
    if (event === "messageCreate") {
      state.handler = handler;
    }
  });
  const offFn = vi.fn((event: string, handler: (msg: Message) => unknown) => {
    if (event === "messageCreate" && state.handler === handler) {
      state.handler = undefined;
    }
  });
  return {
    on: onFn,
    off: offFn,
    emit: (msg: Message) => {
      if (state.handler) state.handler(msg);
    },
    get registeredHandler() {
      return state.handler;
    },
  } as unknown as MockClient;
}

// -----------------------------------------------------------------------------
// Synthetic Message constructor. We only populate the fields the listener
// reads (`channelId`, `author.bot`, attachments.size, content, and an `id`
// for debug parity).
//
// Single-channel mode: the listener now pre-filters by message shape. A
// morning-row / strength run only accepts a message WITH an attachment; a
// wind-down run only accepts text containing the trigger phrase. Tests
// that want the proof handler to fire must opt into one of those shapes.
// -----------------------------------------------------------------------------
interface FakeMessageOptions {
  readonly channelId: string;
  readonly bot?: boolean;
  readonly id?: string;
  readonly content?: string;
  /** Sets attachments.size = 1 (or 0) so the pre-filter sees a photo. */
  readonly hasAttachment?: boolean;
}

function makeMessage(opts: FakeMessageOptions): Message {
  const size = opts.hasAttachment ? 1 : 0;
  return {
    id: opts.id ?? "m-" + randomUUID(),
    channelId: opts.channelId,
    content: opts.content ?? "hi",
    author: { bot: opts.bot ?? false },
    attachments: { size },
  } as unknown as Message;
}

// -----------------------------------------------------------------------------
// LocalDateString helper duplicated here so the test can assert today/yesterday
// strings without coupling to the implementation file's private function.
// -----------------------------------------------------------------------------
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

interface SeedRunOptions {
  readonly habitId: string;
  readonly fireDate: string;
  readonly status:
    | "pending"
    | "partial"
    | "completed"
    | "missed"
    | "skipped"
    | "unresolved"
    | "unresolved_no_data";
  readonly currentLevel?: number;
  readonly proofRejectionCalloutDue?: 0 | 1;
}

function seedRun(db: Database.Database, opts: SeedRunOptions): string {
  const id = "run-" + randomUUID();
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level,
       next_escalation_at, status, completed_at, proof_payload_json,
       skip_reason, proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
  ).run(
    id,
    opts.habitId,
    opts.fireDate,
    Date.now(),
    opts.currentLevel ?? 1,
    opts.status,
    opts.proofRejectionCalloutDue ?? 0,
  );
  return id;
}

interface Harness {
  readonly db: Database.Database;
  readonly adapter: DiscordAdapter;
  readonly mockClient: MockClient;
  readonly now: Date;
}

async function buildHarness(now: Date = new Date("2026-05-12T10:30:00")): Promise<Harness> {
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

describe("subscribeMessages()", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  it("registers a messageCreate listener and the returned unsubscribe removes it", async () => {
    const handler = vi.fn();
    const unsub = subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => h.now,
    });

    expect(h.mockClient.on).toHaveBeenCalledTimes(1);
    const [event, registered] = h.mockClient.on.mock.calls[0]!;
    expect(event).toBe("messageCreate");
    expect(typeof registered).toBe("function");
    expect(h.mockClient.registeredHandler).toBe(registered);

    unsub();

    expect(h.mockClient.off).toHaveBeenCalledTimes(1);
    const [offEvent, offHandler] = h.mockClient.off.mock.calls[0]!;
    expect(offEvent).toBe("messageCreate");
    expect(offHandler).toBe(registered);
    expect(h.mockClient.registeredHandler).toBeUndefined();
  });

  it("skips bot messages (author.bot === true)", async () => {
    seedRun(h.db, {
      habitId: "morning-row",
      fireDate: localDateString(h.now),
      status: "pending",
    });

    const handler = vi.fn();
    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => h.now,
    });

    h.mockClient.emit(makeMessage({ channelId: CH_MORNING_ROW, bot: true }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("skips messages in non-active channels (wins channel ignored)", async () => {
    const handler = vi.fn();
    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => h.now,
    });

    h.mockClient.emit(makeMessage({ channelId: CH_WINS }));
    h.mockClient.emit(makeMessage({ channelId: CH_SUNDAY_REVIEW }));
    h.mockClient.emit(makeMessage({ channelId: "9999999999999999999" }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not invoke the handler when there is no active run for today", async () => {
    const handler = vi.fn();
    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => h.now,
    });

    h.mockClient.emit(makeMessage({ channelId: CH_MORNING_ROW }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("invokes the handler with {run, message, channelName} for an active pending run", async () => {
    const today = localDateString(h.now);
    const runId = seedRun(h.db, {
      habitId: "morning-row",
      fireDate: today,
      status: "pending",
      currentLevel: 2,
      proofRejectionCalloutDue: 1,
    });

    const handler = vi.fn();
    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => h.now,
    });

    // Pre-filter requires an attachment for `concept2_api+photo_fallback`.
    const msg = makeMessage({
      channelId: CH_MORNING_ROW,
      content: "rowed",
      hasAttachment: true,
    });
    h.mockClient.emit(msg);

    expect(handler).toHaveBeenCalledTimes(1);
    const arg = handler.mock.calls[0]![0] as MessageMatch;
    expect(arg.channelName).toBe<ChannelName>("morning-row");
    expect(arg.message).toBe(msg);
    expect(arg.run.id).toBe(runId);
    expect(arg.run.habit_id).toBe("morning-row");
    expect(arg.run.fire_date).toBe(today);
    expect(arg.run.current_level).toBe(2);
    expect(arg.run.status).toBe("pending");
    expect(arg.run.proof_rejection_callout_due).toBe(1);
  });

  it("invokes the handler when the active run is in 'partial' status (wind-down stage A)", async () => {
    const today = localDateString(h.now);
    const runId = seedRun(h.db, {
      habitId: "wind-down",
      fireDate: today,
      status: "partial",
    });

    const handler = vi.fn();
    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => h.now,
    });

    // Pre-filter requires the wind-down trigger phrase "shutting down".
    h.mockClient.emit(
      makeMessage({ channelId: CH_WIND_DOWN, content: "shutting down for the night" }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const arg = handler.mock.calls[0]![0] as MessageMatch;
    expect(arg.channelName).toBe<ChannelName>("wind-down");
    expect(arg.run.id).toBe(runId);
    expect(arg.run.status).toBe("partial");
  });

  it("does not match runs whose status is completed / missed / skipped / unresolved", async () => {
    const today = localDateString(h.now);
    const terminalStatuses = [
      "completed",
      "missed",
      "skipped",
      "unresolved",
      "unresolved_no_data",
    ] as const;

    const handler = vi.fn();
    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => h.now,
    });

    for (const status of terminalStatuses) {
      // Wipe the table between iterations to honour the (habit_id, fire_date)
      // unique constraint while exercising every terminal status.
      h.db.prepare("DELETE FROM habit_runs").run();
      seedRun(h.db, { habitId: "morning-row", fireDate: today, status });

      h.mockClient.emit(makeMessage({ channelId: CH_MORNING_ROW }));
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not match a pending run whose fire_date is yesterday (local-time today)", async () => {
    const yesterday = new Date(h.now);
    yesterday.setDate(yesterday.getDate() - 1);

    seedRun(h.db, {
      habitId: "morning-row",
      fireDate: localDateString(yesterday),
      status: "pending",
    });

    const handler = vi.fn();
    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => h.now,
    });

    h.mockClient.emit(makeMessage({ channelId: CH_MORNING_ROW }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("uses the injected `now` to resolve today's fire_date in local time", async () => {
    // Force `now` to a specific local date that differs from the seeded run's
    // fire_date by one day, then re-run with the right local date.
    const tomorrow = new Date(h.now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    seedRun(h.db, {
      habitId: "morning-row",
      fireDate: localDateString(tomorrow),
      status: "pending",
    });

    const handler = vi.fn();
    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => tomorrow,
    });

    h.mockClient.emit(
      makeMessage({ channelId: CH_MORNING_ROW, hasAttachment: true }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const arg = handler.mock.calls[0]![0] as MessageMatch;
    const run: ActiveHabitRun = arg.run;
    expect(run.fire_date).toBe(localDateString(tomorrow));
  });

  it("catches async handler rejections and keeps the listener functional for subsequent messages", async () => {
    const today = localDateString(h.now);
    seedRun(h.db, {
      habitId: "morning-row",
      fireDate: today,
      status: "pending",
    });
    seedRun(h.db, {
      habitId: "strength-mwf",
      fireDate: today,
      status: "pending",
    });

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    let callCount = 0;
    const handler = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("first call boom");
      }
    });

    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => h.now,
    });

    // Both morning-row and strength accept attachments — pre-filter passes.
    h.mockClient.emit(
      makeMessage({ channelId: CH_MORNING_ROW, hasAttachment: true }),
    );
    h.mockClient.emit(
      makeMessage({ channelId: CH_STRENGTH, hasAttachment: true }),
    );

    // Allow the rejected promise (caught inside the listener) to settle.
    await new Promise((r) => setImmediate(r));

    expect(handler).toHaveBeenCalledTimes(2);
    // The second message still resolved its row, proving the listener
    // survived the first call's rejection.
    expect(
      (handler.mock.calls[1]![0] as MessageMatch).channelName,
    ).toBe<ChannelName>("strength");
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("matches each active channel independently when both have today's pending run", async () => {
    const today = localDateString(h.now);
    const morningRunId = seedRun(h.db, {
      habitId: "morning-row",
      fireDate: today,
      status: "pending",
    });
    const strengthRunId = seedRun(h.db, {
      habitId: "strength-mwf",
      fireDate: today,
      status: "pending",
    });

    const handler = vi.fn();
    subscribeMessages({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => h.now,
    });

    h.mockClient.emit(
      makeMessage({ channelId: CH_MORNING_ROW, hasAttachment: true }),
    );
    h.mockClient.emit(
      makeMessage({ channelId: CH_STRENGTH, hasAttachment: true }),
    );

    expect(handler).toHaveBeenCalledTimes(2);
    const first = handler.mock.calls[0]![0] as MessageMatch;
    const second = handler.mock.calls[1]![0] as MessageMatch;
    expect(first.channelName).toBe<ChannelName>("morning-row");
    expect(first.run.id).toBe(morningRunId);
    expect(second.channelName).toBe<ChannelName>("strength");
    expect(second.run.id).toBe(strengthRunId);
  });
});
