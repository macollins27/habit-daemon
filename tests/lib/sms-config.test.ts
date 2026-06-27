import { describe, it, expect } from "vitest";
import {
  loadSmsConfigFromEnv,
  isWithinQuietHours,
  intervalElapsed,
  parseHhmm,
} from "../../src/lib/sms-config.js";

describe("loadSmsConfigFromEnv", () => {
  it("defaults to disabled with the documented cap/interval when nothing is set", () => {
    const cfg = loadSmsConfigFromEnv({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.toNumber).toBeNull();
    expect(cfg.maxPerDay).toBe(12);
    expect(cfg.minIntervalMinutes).toBe(10);
  });

  it("throws when enabled but no destination number (fail-fast)", () => {
    expect(() => loadSmsConfigFromEnv({ SMS_ENABLED: "true" })).toThrow(
      /SMS_TO_NUMBER is missing/,
    );
  });

  it("throws when enabled with a non-E.164 number", () => {
    expect(() =>
      loadSmsConfigFromEnv({ SMS_ENABLED: "true", SMS_TO_NUMBER: "813-555" }),
    ).toThrow(/E\.164/);
  });

  it("loads an enabled config with valid number + quiet hours + overrides", () => {
    const cfg = loadSmsConfigFromEnv({
      SMS_ENABLED: "true",
      SMS_TO_NUMBER: "+18135551234",
      SMS_QUIET_HOURS_START: "22:00",
      SMS_QUIET_HOURS_END: "07:00",
      DAILY_ALIGNMENT_SMS_MAX_PER_DAY: "8",
      DAILY_ALIGNMENT_SMS_MIN_INTERVAL_MINUTES: "20",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.toNumber).toBe("+18135551234");
    expect(cfg.quietHoursStart).toBe("22:00");
    expect(cfg.quietHoursEnd).toBe("07:00");
    expect(cfg.maxPerDay).toBe(8);
    expect(cfg.minIntervalMinutes).toBe(20);
  });

  it("throws when only one quiet-hours bound is set", () => {
    expect(() =>
      loadSmsConfigFromEnv({ SMS_QUIET_HOURS_START: "22:00" }),
    ).toThrow(/must be set together/);
  });

  it("throws on a non-positive cap", () => {
    expect(() =>
      loadSmsConfigFromEnv({ DAILY_ALIGNMENT_SMS_MAX_PER_DAY: "0" }),
    ).toThrow(/positive integer/);
  });
});

describe("parseHhmm", () => {
  it("parses valid times and rejects junk", () => {
    expect(parseHhmm("07:30")).toEqual({ h: 7, m: 30 });
    expect(parseHhmm("23:59")).toEqual({ h: 23, m: 59 });
    expect(parseHhmm("24:00")).toBeNull();
    expect(parseHhmm("9:99")).toBeNull();
    expect(parseHhmm("nope")).toBeNull();
  });
});

describe("isWithinQuietHours", () => {
  const at = (h: number, m: number): Date => new Date(2026, 5, 27, h, m, 0);

  it("returns false when quiet hours are unconfigured", () => {
    expect(isWithinQuietHours(at(3, 0), null, null)).toBe(false);
  });

  it("handles an overnight window (22:00 → 07:00)", () => {
    expect(isWithinQuietHours(at(23, 0), "22:00", "07:00")).toBe(true);
    expect(isWithinQuietHours(at(2, 0), "22:00", "07:00")).toBe(true);
    expect(isWithinQuietHours(at(6, 59), "22:00", "07:00")).toBe(true);
    expect(isWithinQuietHours(at(7, 0), "22:00", "07:00")).toBe(false);
    expect(isWithinQuietHours(at(12, 0), "22:00", "07:00")).toBe(false);
    expect(isWithinQuietHours(at(21, 59), "22:00", "07:00")).toBe(false);
  });

  it("handles a same-day window (09:00 → 17:00)", () => {
    expect(isWithinQuietHours(at(12, 0), "09:00", "17:00")).toBe(true);
    expect(isWithinQuietHours(at(9, 0), "09:00", "17:00")).toBe(true);
    expect(isWithinQuietHours(at(17, 0), "09:00", "17:00")).toBe(false);
    expect(isWithinQuietHours(at(8, 59), "09:00", "17:00")).toBe(false);
  });

  it("treats start === end as an empty (never-quiet) window", () => {
    expect(isWithinQuietHours(at(8, 0), "08:00", "08:00")).toBe(false);
  });
});

describe("intervalElapsed", () => {
  const now = 1_000_000_000_000;

  it("allows the first send (no prior timestamp)", () => {
    expect(intervalElapsed(null, now, 10)).toBe(true);
    expect(intervalElapsed(undefined, now, 10)).toBe(true);
  });

  it("blocks a send inside the minimum interval", () => {
    expect(intervalElapsed(now - 5 * 60_000, now, 10)).toBe(false);
  });

  it("allows a send once the interval has elapsed", () => {
    expect(intervalElapsed(now - 10 * 60_000, now, 10)).toBe(true);
    expect(intervalElapsed(now - 11 * 60_000, now, 10)).toBe(true);
  });
});
