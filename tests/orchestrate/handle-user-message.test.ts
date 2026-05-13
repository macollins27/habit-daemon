// Phase 4 / Task 4.3: tests for handleUserMessage.
//
// The orchestrator is the single chat-handling entry point. Each test
// pins one slice of the contract:
//   - 5-second per-channel rate limit (silent drop)
//   - happy path: user + assistant events persisted, postImpl called
//   - error path: dispatch throws -> apology posted, assistant event written
//   - ctx is threaded into dispatchImpl (spy on the `system` argument)
//   - empty text is still processed (no special-case skip)
//   - channelName: null still processes cleanly

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import { SessionStore } from "../../src/daemon/session-store.js";
import { handleUserMessage } from "../../src/orchestrate/handle-user-message.js";

const CH_MORNING_ROW = "1000000000000000001";
const NOW_MS = Date.parse("2026-05-13T10:00:00.000Z");

interface Harness {
  readonly tempDir: string;
  readonly sessionStore: SessionStore;
  readonly db: Database.Database;
}

async function buildHarness(): Promise<Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-handle-msg-"));
  const dbPath = join(tempDir, "test.db");
  const migrator = openDatabase(dbPath);
  await runMigrations(migrator, loadMigrations());
  seedHabits(migrator, {
    morningRow: CH_MORNING_ROW,
    strength: "1000000000000000002",
    windDown: "1000000000000000003",
  });
  migrator.close();
  const sessionStore = new SessionStore({ dbPath });
  return { tempDir, sessionStore, db: sessionStore.db };
}

function teardownHarness(h: Harness): void {
  h.sessionStore.close();
  rmSync(h.tempDir, { recursive: true, force: true });
}

interface ChatEventRow {
  readonly event_type: string;
  readonly event_json: string;
}

function readChatEvents(db: Database.Database): readonly ChatEventRow[] {
  return db
    .prepare(
      `SELECT event_type, event_json
         FROM session_events
        WHERE session_id = 'chat'
        ORDER BY id ASC`,
    )
    .all() as readonly ChatEventRow[];
}

describe("handleUserMessage", () => {
  let h: Harness;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h = await buildHarness();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    teardownHarness(h);
  });

  it("silently drops the message when an assistant reply went out <5s ago in the same channel", async () => {
    // Seed a prior assistant message via the real append path. session_events
    // is append-only (UPDATE/DELETE triggers RAISE) so we cannot back-date
    // an existing row. Instead we read the just-appended event's written_iso
    // and pass `now = lastIsoMs + 1_000` so the rate-limit window (5s)
    // catches the next call.
    h.sessionStore.append(
      "chat",
      "assistant_message_sent",
      { channelId: CH_MORNING_ROW, text: "earlier reply", cost_usd: 0.01 },
      { trustLevel: "L1" },
    );
    const lastIsoRow = h.db
      .prepare(
        `SELECT written_iso FROM session_events
          WHERE event_type = 'assistant_message_sent'
          ORDER BY id DESC LIMIT 1`,
      )
      .get() as { written_iso: string };
    const nowWithinWindow = Date.parse(lastIsoRow.written_iso) + 1_000;

    const dispatchImpl = vi.fn(async () => ({ text: "should never run", cost_usd: 0 }));
    const postImpl = vi.fn(async () => undefined);

    await handleUserMessage({
      sessionStore: h.sessionStore,
      channelId: CH_MORNING_ROW,
      channelName: "morning-row",
      text: "hello?",
      now: nowWithinWindow,
      dispatchImpl,
      postImpl,
    });

    expect(dispatchImpl).not.toHaveBeenCalled();
    expect(postImpl).not.toHaveBeenCalled();
  });

  it("happy path: writes user + assistant events and posts the reply", async () => {
    const dispatchImpl = vi.fn(async () => ({ text: "yes", cost_usd: 0.01 }));
    const postImpl = vi.fn(async () => undefined);

    await handleUserMessage({
      sessionStore: h.sessionStore,
      channelId: CH_MORNING_ROW,
      channelName: "morning-row",
      text: "did I row today?",
      now: NOW_MS,
      dispatchImpl,
      postImpl,
    });

    const events = readChatEvents(h.db);
    expect(events.length).toBe(2);
    expect(events[0]!.event_type).toBe("user_message_received");
    expect(events[1]!.event_type).toBe("assistant_message_sent");

    const userPayload = JSON.parse(events[0]!.event_json) as {
      channelId: string;
      text: string;
    };
    expect(userPayload.channelId).toBe(CH_MORNING_ROW);
    expect(userPayload.text).toBe("did I row today?");

    const assistantPayload = JSON.parse(events[1]!.event_json) as {
      channelId: string;
      text: string;
      cost_usd: number;
    };
    expect(assistantPayload.text).toBe("yes");
    expect(assistantPayload.cost_usd).toBe(0.01);

    expect(postImpl).toHaveBeenCalledTimes(1);
    expect(postImpl).toHaveBeenCalledWith({
      channelId: CH_MORNING_ROW,
      content: "yes",
    });
  });

  it("error path: dispatch throws -> apology posted + assistant_message_sent with cost_usd=0", async () => {
    const dispatchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const postImpl = vi.fn(async () => undefined);

    await handleUserMessage({
      sessionStore: h.sessionStore,
      channelId: CH_MORNING_ROW,
      channelName: "morning-row",
      text: "hi",
      now: NOW_MS,
      dispatchImpl,
      postImpl,
    });

    const events = readChatEvents(h.db);
    expect(events.length).toBe(2);
    const assistantPayload = JSON.parse(events[1]!.event_json) as {
      text: string;
      cost_usd: number;
    };
    expect(assistantPayload.text).toMatch(/error/i);
    expect(assistantPayload.cost_usd).toBe(0);

    expect(postImpl).toHaveBeenCalledTimes(1);
    expect(postImpl.mock.calls[0]![0]?.content).toMatch(/error/i);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("threads loaded context into dispatchImpl: the system prompt embeds the channelName", async () => {
    const dispatchImpl = vi.fn(async (opts: {
      readonly system: string;
      readonly user: string;
      readonly maxBudgetUsd: number;
    }) => {
      expect(opts.system).toMatch(/morning-row/);
      // Also assert the JSON context block is present.
      expect(opts.system).toMatch(/```json/);
      expect(opts.user).toBe("question?");
      expect(opts.maxBudgetUsd).toBeGreaterThan(0);
      return { text: "ok", cost_usd: 0.02 };
    });
    const postImpl = vi.fn(async () => undefined);

    await handleUserMessage({
      sessionStore: h.sessionStore,
      channelId: CH_MORNING_ROW,
      channelName: "morning-row",
      text: "question?",
      now: NOW_MS,
      dispatchImpl,
      postImpl,
    });

    expect(dispatchImpl).toHaveBeenCalledTimes(1);
  });

  it("processes empty text without skipping (the model handles the no-content case)", async () => {
    const dispatchImpl = vi.fn(async () => ({ text: "I didn't see a question.", cost_usd: 0 }));
    const postImpl = vi.fn(async () => undefined);

    await handleUserMessage({
      sessionStore: h.sessionStore,
      channelId: CH_MORNING_ROW,
      channelName: "morning-row",
      text: "",
      now: NOW_MS,
      dispatchImpl,
      postImpl,
    });

    expect(dispatchImpl).toHaveBeenCalledTimes(1);
    expect(postImpl).toHaveBeenCalledTimes(1);
    const events = readChatEvents(h.db);
    expect(events.length).toBe(2);
  });

  it("processes channelName: null cleanly", async () => {
    const dispatchImpl = vi.fn(async (opts: {
      readonly system: string;
      readonly user: string;
      readonly maxBudgetUsd: number;
    }) => {
      // The prompt's null-channel branch is exercised.
      expect(opts.system).toMatch(/not tied to a specific active habit/);
      return { text: "ok", cost_usd: 0 };
    });
    const postImpl = vi.fn(async () => undefined);

    await handleUserMessage({
      sessionStore: h.sessionStore,
      channelId: CH_MORNING_ROW,
      channelName: null,
      text: "hi",
      now: NOW_MS,
      dispatchImpl,
      postImpl,
    });

    expect(dispatchImpl).toHaveBeenCalledTimes(1);
    expect(postImpl).toHaveBeenCalledTimes(1);
  });

  it("swallows postImpl failures so the listener thread never crashes", async () => {
    const dispatchImpl = vi.fn(async () => ({ text: "ok", cost_usd: 0 }));
    const postImpl = vi.fn(async () => {
      throw new Error("discord network blip");
    });

    // Should not throw despite postImpl rejecting.
    await expect(
      handleUserMessage({
        sessionStore: h.sessionStore,
        channelId: CH_MORNING_ROW,
        channelName: "morning-row",
        text: "hi",
        now: NOW_MS,
        dispatchImpl,
        postImpl,
      }),
    ).resolves.toBeUndefined();

    // Both events still persisted — the post failure happens after the
    // assistant event was written.
    const events = readChatEvents(h.db);
    expect(events.length).toBe(2);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
