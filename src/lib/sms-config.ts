/**
 * Runtime config for the capped iMessage/SMS escalation transport, plus the
 * pure time-window helpers the escalation loop uses to decide whether a text
 * is allowed right now.
 *
 * Design intent (the whole reason this transport is BOUNDED, not "text me
 * forever"): the daily-alignment habit may nag by text until proof is
 * accepted, but never past three hard limits —
 *   1. a per-calendar-day cap (default 12),
 *   2. a minimum interval between texts (default 10 minutes),
 *   3. quiet hours (no texts inside a configured nightly window).
 * This module owns (1)'s/(2)'s timing predicates and (3) entirely; the
 * per-day COUNT itself is read from the ledger at the call site (so a daemon
 * restart cannot reset the cap). See the escalation wiring.
 *
 * Fail-fast: if SMS is enabled but the destination number is missing or
 * malformed, `loadSmsConfigFromEnv` throws at startup — a misconfigured
 * transport must not silently no-op for hours.
 */

export interface SmsConfig {
  readonly enabled: boolean;
  /** E.164 destination, or null when disabled. */
  readonly toNumber: string | null;
  /** "HH:MM" 24h local, or null when quiet hours are unconfigured. */
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  readonly maxPerDay: number;
  readonly minIntervalMinutes: number;
}

export interface ParsedHhmm {
  readonly h: number;
  readonly m: number;
}

const ENV = {
  enabled: "SMS_ENABLED",
  toNumber: "SMS_TO_NUMBER",
  quietStart: "SMS_QUIET_HOURS_START",
  quietEnd: "SMS_QUIET_HOURS_END",
  maxPerDay: "DAILY_ALIGNMENT_SMS_MAX_PER_DAY",
  minInterval: "DAILY_ALIGNMENT_SMS_MIN_INTERVAL_MINUTES",
} as const;

const DEFAULT_MAX_PER_DAY = 12;
const DEFAULT_MIN_INTERVAL_MINUTES = 10;

/** Parse "HH:MM" (24h). Returns null on any malformed value. */
export function parseHhmm(value: string): ParsedHhmm | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

function parseBool(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  envName: string,
): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${envName} must be a positive integer (got "${value}")`,
    );
  }
  return n;
}

/**
 * Load + validate the SMS config from the environment. Fail-fast on an
 * enabled-but-misconfigured transport.
 */
export function loadSmsConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SmsConfig {
  const enabled = parseBool(env[ENV.enabled]);

  const maxPerDay = parsePositiveInt(
    env[ENV.maxPerDay],
    DEFAULT_MAX_PER_DAY,
    ENV.maxPerDay,
  );
  const minIntervalMinutes = parsePositiveInt(
    env[ENV.minInterval],
    DEFAULT_MIN_INTERVAL_MINUTES,
    ENV.minInterval,
  );

  // Quiet hours: optional, but if either bound is set BOTH must be set and valid.
  const rawStart = env[ENV.quietStart]?.trim() ?? "";
  const rawEnd = env[ENV.quietEnd]?.trim() ?? "";
  let quietHoursStart: string | null = null;
  let quietHoursEnd: string | null = null;
  if (rawStart.length > 0 || rawEnd.length > 0) {
    if (rawStart.length === 0 || rawEnd.length === 0) {
      throw new Error(
        `${ENV.quietStart} and ${ENV.quietEnd} must be set together`,
      );
    }
    if (parseHhmm(rawStart) === null) {
      throw new Error(`${ENV.quietStart} must be "HH:MM" (got "${rawStart}")`);
    }
    if (parseHhmm(rawEnd) === null) {
      throw new Error(`${ENV.quietEnd} must be "HH:MM" (got "${rawEnd}")`);
    }
    quietHoursStart = rawStart;
    quietHoursEnd = rawEnd;
  }

  if (!enabled) {
    return {
      enabled: false,
      toNumber: null,
      quietHoursStart,
      quietHoursEnd,
      maxPerDay,
      minIntervalMinutes,
    };
  }

  // Enabled → destination number is mandatory and must look like E.164.
  const rawNumber = env[ENV.toNumber]?.trim() ?? "";
  if (rawNumber.length === 0) {
    throw new Error(
      `${ENV.enabled}=true but ${ENV.toNumber} is missing — refusing to start a text transport with no destination`,
    );
  }
  if (!/^\+[1-9]\d{6,14}$/.test(rawNumber)) {
    throw new Error(
      `${ENV.toNumber} must be E.164 (e.g. +18135551234), got "${rawNumber}"`,
    );
  }

  return {
    enabled: true,
    toNumber: rawNumber,
    quietHoursStart,
    quietHoursEnd,
    maxPerDay,
    minIntervalMinutes,
  };
}

/**
 * Is `now` (process local time) inside the quiet-hours window? Returns false
 * when quiet hours are unconfigured. Handles an overnight window (start > end,
 * e.g. 22:00→07:00) by treating it as [start, midnight) ∪ [midnight, end).
 * A start === end window is treated as empty (never quiet).
 */
export function isWithinQuietHours(
  now: Date,
  start: string | null,
  end: string | null,
): boolean {
  if (start === null || end === null) return false;
  const s = parseHhmm(start);
  const e = parseHhmm(end);
  if (s === null || e === null) return false;

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = s.h * 60 + s.m;
  const endMin = e.h * 60 + e.m;

  if (startMin === endMin) return false; // empty window
  if (startMin < endMin) {
    // Same-day window, e.g. 09:00→17:00.
    return nowMin >= startMin && nowMin < endMin;
  }
  // Overnight window, e.g. 22:00→07:00.
  return nowMin >= startMin || nowMin < endMin;
}

/**
 * Has enough time passed since the last text to send another? `lastSentMs`
 * null/undefined (no prior text today) → always allowed.
 */
export function intervalElapsed(
  lastSentMs: number | null | undefined,
  now: number,
  minIntervalMinutes: number,
): boolean {
  if (lastSentMs === null || lastSentMs === undefined) return true;
  return now - lastSentMs >= minIntervalMinutes * 60_000;
}

/**
 * Epoch ms of the next local-time occurrence of `hhmm` strictly after `now`.
 * Used to re-arm the next escalation to the end of a quiet-hours window so the
 * loop sleeps through quiet hours instead of firing inside them.
 */
export function nextLocalTimeAfter(now: number, hhmm: string): number | null {
  const parsed = parseHhmm(hhmm);
  if (parsed === null) return null;
  const d = new Date(now);
  const candidate = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    parsed.h,
    parsed.m,
    0,
    0,
  );
  if (candidate.getTime() <= now) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}
