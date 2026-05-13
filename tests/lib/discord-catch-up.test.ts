// Phase 5: bootstrap catch-up sweep tests.
//
// `catchUpOnStartup` is invoked between Discord `ready` and live
// `subscribeMessages` in bootstrap. For each active channel it:
//   1. Reads the persisted cursor from `discord_channel_cursors`.
//   2. Fetches up to `limit` recent messages via `client.channels.fetch(id)`
//      then `channel.messages.fetch({limit})`.
//   3. Filters: newer than cursor (or all, if no cursor) AND non-bot.
//   4. Sorts chronological (oldest first).
//   5. Advances the cursor on each observed message.
//   6. Looks up today's pending/partial habit_runs row using the same SQL
//      as the live listener; if matched, invokes the caller's handler.
//
// These tests build a mock `client.channels.fetch` + `channel.messages.fetch`
// so no gateway connection is required. The DB side runs the real migrations
// and seed in an in-memory SQLite so the lookup query exercises the real
// schema.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Client, Message } from "discord.js";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import {
  catchUpOnStartup,
  createDiscordAdapter,
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

interface FakeMessageOptions {
  readonly channelId: string;
  readonly createdAt: Date;
  readonly bot?: boolean;
  readonly id?: string;
  readonly content?: string;
}

function makeMessage(opts: FakeMessageOptions): Message {
  return {
    id: opts.id ?? "m-" + randomUUID(),
    channelId: opts.channelId,
    content: opts.content ?? "",
    author: { bot: opts.bot ?? false },
    createdAt: opts.createdAt,
  } as unknown as Message;
}

// YYYY-MM-DD in local time — matches the implementation's localDateString.
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

interface SeedRunOptions {
  readonly habitId: string;
  readonly fireDate: string;
  readonly status: "pending" | "partial";
}

function seedRun(db: Database.Database, opts: SeedRunOptions): string {
  const id = "run-" + randomUUID();
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level,
       next_escalation_at, status, completed_at, proof_payload_json,
       skip_reason, proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, 0)`,
  ).run(id, opts.habitId, opts.fireDate, Date.now(), 1, opts.status);
  return id;
}

interface MockClientShape {
  readonly channels: {
    readonly fetch: ReturnType<typeof vi.fn>;
  };
}

interface ChannelMockSpec {
  readonly channelId: string;
  readonly messages: readonly Message[];
  readonly isTextBased?: boolean;
  readonly fetchError?: Error;
  readonly messagesFetchError?: Error;
}

function buildMockClient(specs: readonly ChannelMockSpec[]): MockClientShape {
  const byId = new Map<string, ChannelMockSpec>();
  for (const s of specs) byId.set(s.channelId, s);

  const fetch = vi.fn(async (id: string) => {
    const spec = byId.get(id);
    if (spec === undefined) return null;
    if (spec.fetchError) throw spec.fetchError;

    const fakeChannel = {
      isTextBased: () => spec.isTextBased ?? true,
      messages: {
        fetch: vi.fn(async () => {
          if (spec.messagesFetchError) throw spec.messagesFetchError;
          const map = new Map<string, Message>();
          for (const m of spec.messages) map.set(m.id, m);
          return map;
        }),
      },
    };
    return fakeChannel;
  });

  return { channels: { fetch } };
}

interface Harness {
  readonly db: Database.Database;
  readonly adapter: DiscordAdapter;
  readonly now: Date;
}

async function buildHarness(
  channelSpecs: readonly ChannelMockSpec[],
  now: Date = new Date("2026-05-13T12:00:00"),
): Promise<Harness> {
  const db = openDatabase(":memory:");
  await runMigrations(db, loadMigrations());
  seedHabits(db, {
    morningRow: CH_MORNING_ROW,
    strength: CH_STRENGTH,
    windDown: CH_WIND_DOWN,
  });

  const mockClient = buildMockClient(channelSpecs);
  const adapter = createDiscordAdapter({
    botToken: "test-bot-token",
    channelIds: validChannelIds(),
    clientFactory: () => mockClient as unknown as Client,
  });

  return { db, adapter, now };
}

function seedCursor(
  db: Database.Database,
  channelId: string,
  lastSeenIso: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO discord_channel_cursors
       (channel_id, last_seen_iso, updated_at)
     VALUES (?, ?, ?)`,
  ).run(channelId, lastSeenIso, Date.now());
}

describe("catchUpOnStartup()", () => {
  let h: Harness;

  afterEach(() => {
    h?.db.close();
  });

  it("replays messages newer than the cursor in chronological order", async () => {
    const at0900 = new Date("2026-05-13T09:00:00Z");
    const at1030 = new Date("2026-05-13T10:30:00Z");
    const at1100 = new Date("2026-05-13T11:00:00Z");

    const messages = [
      makeMessage({ channelId: CH_MORNING_ROW, createdAt: at1100, id: "m-1100" }),
      makeMessage({ channelId: CH_MORNING_ROW, createdAt: at0900, id: "m-0900" }),
      makeMessage({ channelId: CH_MORNING_ROW, createdAt: at1030, id: "m-1030" }),
    ];

    h = await buildHarness([
      { channelId: CH_MORNING_ROW, messages },
      { channelId: CH_STRENGTH, messages: [] },
      { channelId: CH_WIND_DOWN, messages: [] },
    ]);

    seedRun(h.db, {
      habitId: "morning-row",
      fireDate: localDateString(h.now),
      status: "pending",
    });

    seedCursor(h.db, CH_MORNING_ROW, "2026-05-13T10:00:00.000Z");

    const handler = vi.fn();
    const result = await catchUpOnStartup({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => h.now,
    });

    expect(handler).toHaveBeenCalledTimes(2);
    // Chronological: 10:30 first, then 11:00.
    const firstCall = handler.mock.calls[0]![0] as MessageMatch;
    const secondCall = handler.mock.calls[1]![0] as MessageMatch;
    expect(firstCall.message.id).toBe("m-1030");
    expect(secondCall.message.id).toBe("m-1100");

    const morningRow = result.perChannel.find(
      (r) => r.channelName === "morning-row",
    );
    expect(morningRow).toBeDefined();
    expect(morningRow?.fetched).toBe(3);
    expect(morningRow?.replayed).toBe(2);
  });

  it("replays all messages (up to limit) when no cursor exists", async () => {
    const today = new Date("2026-05-13T12:00:00");
    const at0800 = new Date("2026-05-13T08:00:00Z");
    const at0900 = new Date("2026-05-13T09:00:00Z");
    const at1000 = new Date("2026-05-13T10:00:00Z");

    const messages = [
      makeMessage({ channelId: CH_MORNING_ROW, createdAt: at0800, id: "m-a" }),
      makeMessage({ channelId: CH_MORNING_ROW, createdAt: at0900, id: "m-b" }),
      makeMessage({ channelId: CH_MORNING_ROW, createdAt: at1000, id: "m-c" }),
    ];

    h = await buildHarness(
      [
        { channelId: CH_MORNING_ROW, messages },
        { channelId: CH_STRENGTH, messages: [] },
        { channelId: CH_WIND_DOWN, messages: [] },
      ],
      today,
    );

    seedRun(h.db, {
      habitId: "morning-row",
      fireDate: localDateString(today),
      status: "pending",
    });

    const handler = vi.fn();
    await catchUpOnStartup({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => today,
    });

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("skips bot-authored messages", async () => {
    const now = new Date("2026-05-13T12:00:00");
    const at1000 = new Date("2026-05-13T10:00:00Z");
    const at1100 = new Date("2026-05-13T11:00:00Z");

    const messages = [
      makeMessage({
        channelId: CH_MORNING_ROW,
        createdAt: at1000,
        id: "m-user",
        bot: false,
      }),
      makeMessage({
        channelId: CH_MORNING_ROW,
        createdAt: at1100,
        id: "m-bot",
        bot: true,
      }),
    ];

    h = await buildHarness(
      [
        { channelId: CH_MORNING_ROW, messages },
        { channelId: CH_STRENGTH, messages: [] },
        { channelId: CH_WIND_DOWN, messages: [] },
      ],
      now,
    );

    seedRun(h.db, {
      habitId: "morning-row",
      fireDate: localDateString(now),
      status: "pending",
    });

    const handler = vi.fn();
    await catchUpOnStartup({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => now,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const arg = handler.mock.calls[0]![0] as MessageMatch;
    expect(arg.message.id).toBe("m-user");
  });

  it("skips messages with no matching active habit_run (fetched but not replayed)", async () => {
    const now = new Date("2026-05-13T12:00:00");
    const at1000 = new Date("2026-05-13T10:00:00Z");

    const messages = [
      makeMessage({ channelId: CH_MORNING_ROW, createdAt: at1000, id: "m-x" }),
    ];

    h = await buildHarness(
      [
        { channelId: CH_MORNING_ROW, messages },
        { channelId: CH_STRENGTH, messages: [] },
        { channelId: CH_WIND_DOWN, messages: [] },
      ],
      now,
    );

    // No habit_run seeded — message should be observed but not handled.

    const handler = vi.fn();
    const result = await catchUpOnStartup({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => now,
    });

    expect(handler).not.toHaveBeenCalled();
    const morningRow = result.perChannel.find(
      (r) => r.channelName === "morning-row",
    );
    expect(morningRow?.fetched).toBe(1);
    expect(morningRow?.replayed).toBe(0);
    expect(morningRow?.skipped).toBe(1);
  });

  it("updates the cursor to the newest replayed message's createdAt", async () => {
    const at0900 = new Date("2026-05-13T09:00:00Z");
    const at1030 = new Date("2026-05-13T10:30:00Z");
    const at1100 = new Date("2026-05-13T11:00:00Z");
    const now = new Date("2026-05-13T12:00:00");

    const messages = [
      makeMessage({ channelId: CH_MORNING_ROW, createdAt: at1100, id: "m-1100" }),
      makeMessage({ channelId: CH_MORNING_ROW, createdAt: at0900, id: "m-0900" }),
      makeMessage({ channelId: CH_MORNING_ROW, createdAt: at1030, id: "m-1030" }),
    ];

    h = await buildHarness(
      [
        { channelId: CH_MORNING_ROW, messages },
        { channelId: CH_STRENGTH, messages: [] },
        { channelId: CH_WIND_DOWN, messages: [] },
      ],
      now,
    );

    seedRun(h.db, {
      habitId: "morning-row",
      fireDate: localDateString(now),
      status: "pending",
    });

    seedCursor(h.db, CH_MORNING_ROW, "2026-05-13T10:00:00.000Z");

    const handler = vi.fn();
    await catchUpOnStartup({
      adapter: h.adapter,
      db: h.db,
      handler,
      now: () => now,
    });

    const cursorAfter = h.db
      .prepare(
        "SELECT last_seen_iso FROM discord_channel_cursors WHERE channel_id = ?",
      )
      .get(CH_MORNING_ROW) as { readonly last_seen_iso: string } | undefined;
    expect(cursorAfter).toBeDefined();
    expect(cursorAfter?.last_seen_iso).toBe("2026-05-13T11:00:00.000Z");
  });
});
