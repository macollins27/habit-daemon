// Hand-rolled minimal 5-field cron parser. Supports:
//   - Standard 5-field expression: "minute hour dom month dow"
//   - Each field: "*" | number | "*/N" | "N,M,P" | "N-M"
//   - Aliases: @hourly | @daily | @weekly | @monthly | @yearly
//
// Does NOT support:
//   - Seconds (6-field)
//   - Ranges with steps ("1-5/2")
//   - Day-of-week names ("MON,TUE")
//   - Last-day-of-month ("L"), nth-weekday ("#")
//
// Sufficient for v0.3 scaffolding's common deployment cases (every-N-min,
// hourly, daily-at-time, weekly-on-day). Founder can swap to the cron-parser
// npm package if they need full grammar later.
//
// References:
//   - https://en.wikipedia.org/wiki/Cron#Cron_expression

export interface CronExpr {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
}

// ReadonlyMap avoids the security/detect-object-injection trip that bracket
// access on a plain object would cause when the key is user-supplied.
const ALIAS_MAP: ReadonlyMap<string, string> = new Map([
  ["@hourly", "0 * * * *"],
  ["@daily", "0 0 * * *"],
  ["@midnight", "0 0 * * *"],
  ["@weekly", "0 0 * * 0"],
  ["@monthly", "0 0 1 * *"],
  ["@yearly", "0 0 1 1 *"],
  ["@annually", "0 0 1 1 *"],
]);

const FIELD_BOUNDS: readonly { min: number; max: number }[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // dom
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // dow (0=Sun)
];

interface Bounds {
  readonly min: number;
  readonly max: number;
}

function fillRange(min: number, max: number, step = 1): Set<number> {
  const out = new Set<number>();
  for (let v = min; v <= max; v += step) out.add(v);
  return out;
}

function parseStep(field: string, bounds: Bounds): Set<number> {
  const step = Number(field.slice(2));
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`cron-parser: invalid step "${field}"`);
  }
  return fillRange(bounds.min, bounds.max, step);
}

function parseList(field: string, bounds: Bounds): Set<number> {
  const out = new Set<number>();
  for (const piece of field.split(",")) {
    const n = Number(piece);
    if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) {
      throw new Error(`cron-parser: invalid value "${piece}" in field "${field}"`);
    }
    out.add(n);
  }
  return out;
}

function parseRange(field: string, bounds: Bounds): Set<number> {
  const [aS, bS] = field.split("-");
  const a = Number(aS);
  const b = Number(bS);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < bounds.min || b > bounds.max || a > b) {
    throw new Error(`cron-parser: invalid range "${field}"`);
  }
  return fillRange(a, b);
}

function parseSingle(field: string, bounds: Bounds): Set<number> {
  const n = Number(field);
  if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) {
    throw new Error(
      `cron-parser: invalid value "${field}" (range ${String(bounds.min)}-${String(bounds.max)})`,
    );
  }
  return new Set<number>([n]);
}

function parseField(field: string, bounds: Bounds): Set<number> {
  if (field === "*") return fillRange(bounds.min, bounds.max);
  if (field.startsWith("*/")) return parseStep(field, bounds);
  if (field.includes(",")) return parseList(field, bounds);
  if (field.includes("-")) return parseRange(field, bounds);
  return parseSingle(field, bounds);
}

export function parseCronExpression(expr: string): CronExpr {
  const trimmed = expr.trim();
  const aliased = ALIAS_MAP.get(trimmed) ?? trimmed;
  const fields = aliased.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron-parser: expected 5 fields, got ${String(fields.length)} ("${trimmed}")`);
  }
  const sets = fields.map((f, i) => {
    const bounds = FIELD_BOUNDS.at(i);
    if (bounds === undefined) throw new Error("cron-parser: bounds out of range");
    return parseField(f, bounds);
  });
  const [minute, hour, dom, month, dow] = sets;
  if (
    minute === undefined ||
    hour === undefined ||
    dom === undefined ||
    month === undefined ||
    dow === undefined
  ) {
    throw new Error("cron-parser: field parse returned undefined");
  }
  return { minute, hour, dom, month, dow };
}

/**
 * Compute the next time the cron expression matches at-or-after `from`,
 * scanning minute-by-minute up to `maxScanMinutes` (default 1 year).
 * Returns null if no match found in the scan window.
 *
 * Local time. Single-host, single-timezone deployment; cron strings are
 * interpreted in the process timezone via `Date.prototype.get*` (not
 * `getUTC*`). Changing this to UTC would silently misfire every schedule.
 */
export function nextRun(expr: CronExpr, from: Date, maxScanMinutes = 366 * 24 * 60): Date | null {
  const cursor = new Date(from.getTime());
  // Round up to next minute boundary
  cursor.setSeconds(0, 0);
  if (cursor.getTime() <= from.getTime()) {
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  for (let step = 0; step < maxScanMinutes; step++) {
    if (
      expr.minute.has(cursor.getMinutes()) &&
      expr.hour.has(cursor.getHours()) &&
      expr.dom.has(cursor.getDate()) &&
      expr.month.has(cursor.getMonth() + 1) &&
      expr.dow.has(cursor.getDay())
    ) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/**
 * Convenience: compute next run given a raw expression string. Tries the
 * hand-rolled parser first; falls back to the `cron-parser` npm package's
 * full grammar (ranges-with-step, DOW names, L/# operators) on parse error.
 */
export function nextRunFromString(expr: string, from: Date = new Date()): Date | null {
  try {
    return nextRun(parseCronExpression(expr), from);
  } catch {
    return parseViaCronParserPackage(expr, from);
  }
}

import { CronExpressionParser } from "cron-parser";

function parseViaCronParserPackage(expr: string, from: Date): Date | null {
  try {
    const cronExpr = CronExpressionParser.parse(expr, { currentDate: from });
    const next = cronExpr.next().toDate();
    return next;
  } catch {
    return null;
  }
}
