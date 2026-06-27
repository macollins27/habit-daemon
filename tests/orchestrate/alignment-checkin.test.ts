import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import type { SessionStore } from "../../src/daemon/session-store.js";
import {
  runAlignmentCheckin,
  ALIGNMENT_COPY,
  ALIGNMENT_CADENCE_MINUTES,
  type SendTextOutcome,
} from "../../src/orchestrate/alignment-checkin.js";
import type { SmsConfig } from "../../src/lib/sms-config.js";

const HABIT_ID = "daily-alignment";
const RUN_ID = "run-align-1";
const FIRE_DATE = "2026-06-27";
// 10:00 local — outside a 22:00→07:00 quiet window.
const NOW = new Date(2026, 5, 27, 10, 0, 0).getTime();

const ENABLED: SmsConfig = {
  enabled: true,
  toNumber: "+18135551234",
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  maxPerDay: 12,
  minIntervalMinutes: 10,
};

let tempDir: string;
let db: Database.Database;
let store: SessionStore;

function asStore(d: Database.Database): SessionStore {
  return { db: d } as unknown as SessionStore;
}

function insertAlignmentHabit(): void {
  db.prepare(
    `INSERT INTO habits (id, name, domain, cron_expr, why_stakes_json, proof_type, proof_config_json, channel_id, active, created_at)
     VALUES (?, 'Daily alignment', 'alignment', '0 9 * * *', '{}', 'alignment_text', '{}', 'chan-align', 1, ?)`,
  ).run(HABIT_ID, NOW);
}

function insertRun(status = "pending", nextEsc: number | null = NOW): void {
  db.prepare(
    `INSERT INTO habit_runs (id, habit_id, fire_date, fired_at, current_level, next_escalation_at, status)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(RUN_ID, HABIT_ID, FIRE_DATE, NOW, nextEsc, status);
}

function seedSends(count: number, lastSentAt: number): void {
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO alignment_sms_sends (habit_id, run_id, fire_date, sent_at, level, sms_ok)
       VALUES (?, ?, ?, ?, 1, 1)`,
    ).run(HABIT_ID, RUN_ID, FIRE_DATE, lastSentAt);
  }
}

function runRow(): { status: string; next_escalation_at: number | null } {
  return db
    .prepare(`SELECT status, next_escalation_at FROM habit_runs WHERE id = ?`)
    .get(RUN_ID) as { status: string; next_escalation_at: number | null };
}

function sendCount(): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM alignment_sms_sends WHERE run_id = ?`)
      .get(RUN_ID) as { n: number }
  ).n;
}

const okSend = async (): Promise<SendTextOutcome> => ({ ok: true });

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-align-"));
  db = openDatabase(join(tempDir, "test.db"));
  await runMigrations(db, loadMigrations());
  store = asStore(db);
  insertAlignmentHabit();
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("runAlignmentCheckin", () => {
  it("sends the L1 text on the first escalation and re-arms hourly", async () => {
    insertRun();
    const sendTextImpl = vi.fn(okSend);

    const result = await runAlignmentCheckin({
      sessionStore: store,
      runId: RUN_ID,
      now: NOW,
      smsConfig: ENABLED,
      sendTextImpl,
    });

    expect(result.action).toBe("sent");
    expect(result.smsSent).toBe(true);
    expect(sendTextImpl).toHaveBeenCalledOnce();
    expect(sendTextImpl.mock.calls[0]![0]).toBe(ALIGNMENT_COPY[1]);
    expect(sendCount()).toBe(1);

    const row = runRow();
    expect(row.status).toBe("pending");
    expect(row.next_escalation_at).toBe(NOW + ALIGNMENT_CADENCE_MINUTES * 60_000);
  });

  it("escalates copy by prior count (L2, then L3)", async () => {
    insertRun();
    seedSends(1, NOW - 60 * 60_000); // 1 prior send, an hour ago
    const sendL2 = vi.fn(okSend);
    await runAlignmentCheckin({
      sessionStore: store,
      runId: RUN_ID,
      now: NOW,
      smsConfig: ENABLED,
      sendTextImpl: sendL2,
    });
    expect(sendL2.mock.calls[0]![0]).toBe(ALIGNMENT_COPY[2]);

    seedSends(1, NOW - 30 * 60_000); // now 2 priors
    const sendL3 = vi.fn(okSend);
    await runAlignmentCheckin({
      sessionStore: store,
      runId: RUN_ID,
      now: NOW + 60 * 60_000,
      smsConfig: ENABLED,
      sendTextImpl: sendL3,
    });
    expect(sendL3.mock.calls[0]![0]).toBe(ALIGNMENT_COPY[3]);
  });

  it("stops at the daily cap: the 13th never sends and the run is marked missed", async () => {
    insertRun();
    seedSends(12, NOW - 30 * 60_000); // already at the cap of 12
    const sendTextImpl = vi.fn(okSend);

    const result = await runAlignmentCheckin({
      sessionStore: store,
      runId: RUN_ID,
      now: NOW,
      smsConfig: ENABLED,
      sendTextImpl,
    });

    expect(result.action).toBe("capped");
    expect(sendTextImpl).not.toHaveBeenCalled();
    expect(sendCount()).toBe(12); // no new row
    const row = runRow();
    expect(row.status).toBe("missed");
    expect(row.next_escalation_at).toBeNull();
  });

  it("suppresses texts during quiet hours and re-arms to the window end", async () => {
    insertRun();
    const sendTextImpl = vi.fn(okSend);
    const at23 = new Date(2026, 5, 27, 23, 0, 0).getTime();

    const result = await runAlignmentCheckin({
      sessionStore: store,
      runId: RUN_ID,
      now: at23,
      smsConfig: ENABLED,
      sendTextImpl,
    });

    expect(result.action).toBe("quiet");
    expect(sendTextImpl).not.toHaveBeenCalled();
    expect(sendCount()).toBe(0);
    // Re-armed to 07:00 the next morning.
    const expected = new Date(2026, 5, 28, 7, 0, 0).getTime();
    expect(runRow().next_escalation_at).toBe(expected);
  });

  it("throttles a too-soon escalation to the min-interval floor", async () => {
    insertRun();
    const lastSent = NOW - 5 * 60_000; // 5 min ago, interval is 10
    seedSends(1, lastSent);
    const sendTextImpl = vi.fn(okSend);

    const result = await runAlignmentCheckin({
      sessionStore: store,
      runId: RUN_ID,
      now: NOW,
      smsConfig: ENABLED,
      sendTextImpl,
    });

    expect(result.action).toBe("throttled");
    expect(sendTextImpl).not.toHaveBeenCalled();
    expect(runRow().next_escalation_at).toBe(lastSent + 10 * 60_000);
  });

  it("never throws on a transport failure; records the attempt with sms_ok=0 and re-arms", async () => {
    insertRun();
    const sendTextImpl = vi.fn(
      async (): Promise<SendTextOutcome> => ({ ok: false, error: "not authorized" }),
    );

    const result = await runAlignmentCheckin({
      sessionStore: store,
      runId: RUN_ID,
      now: NOW,
      smsConfig: ENABLED,
      sendTextImpl,
    });

    expect(result.action).toBe("sent");
    expect(result.smsSent).toBe(false);
    expect(sendCount()).toBe(1);
    const okFlag = (
      db
        .prepare(`SELECT sms_ok FROM alignment_sms_sends WHERE run_id = ?`)
        .get(RUN_ID) as { sms_ok: number }
    ).sms_ok;
    expect(okFlag).toBe(0);
    expect(runRow().next_escalation_at).toBe(NOW + ALIGNMENT_CADENCE_MINUTES * 60_000);
  });

  it("when SMS is disabled, sends no text but still posts to Discord and counts the attempt", async () => {
    insertRun();
    const sendTextImpl = vi.fn(okSend);
    const postImpl = vi.fn(async () => ({ messageId: "m1" }));
    const disabled: SmsConfig = { ...ENABLED, enabled: false, toNumber: null };

    const result = await runAlignmentCheckin({
      sessionStore: store,
      runId: RUN_ID,
      now: NOW,
      smsConfig: disabled,
      sendTextImpl,
      postImpl,
    });

    expect(result.action).toBe("sent");
    expect(result.smsSent).toBe(false);
    expect(sendTextImpl).not.toHaveBeenCalled();
    expect(postImpl).toHaveBeenCalledOnce();
    expect(sendCount()).toBe(1);
  });

  it("is a no-op for a non-pending run (already completed)", async () => {
    insertRun("completed", null);
    const sendTextImpl = vi.fn(okSend);

    const result = await runAlignmentCheckin({
      sessionStore: store,
      runId: RUN_ID,
      now: NOW,
      smsConfig: ENABLED,
      sendTextImpl,
    });

    expect(result.action).toBe("noop");
    expect(sendTextImpl).not.toHaveBeenCalled();
    expect(sendCount()).toBe(0);
    expect(runRow().status).toBe("completed");
  });
});
