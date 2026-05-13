/**
 * Format an instant as YYYY-MM-DD in process local time.
 *
 * Matches the cron parser's convention (ADR 0001: cron expressions are
 * interpreted in local time) and the habit_runs.fire_date column. Accepts
 * either a Date or epoch milliseconds — both produce the same output.
 */
export function localDateString(when: Date | number): string {
  const d = typeof when === "number" ? new Date(when) : when;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
