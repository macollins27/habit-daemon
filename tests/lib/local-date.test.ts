import { describe, it, expect } from "vitest";
import { localDateString } from "../../src/lib/local-date.js";

describe("localDateString", () => {
  it("formats a Date to YYYY-MM-DD in local time", () => {
    // Construct a Date using local-time fields so the assertion is
    // timezone-independent (the helper formats in process local time).
    const d = new Date(2026, 4, 13, 9, 30, 0); // 2026-05-13 09:30 local
    expect(localDateString(d)).toBe("2026-05-13");
  });

  it("accepts epoch milliseconds and produces the same output as the Date form", () => {
    const d = new Date(2026, 10, 7, 23, 59, 0); // 2026-11-07 23:59 local
    expect(localDateString(d.getTime())).toBe("2026-11-07");
    expect(localDateString(d.getTime())).toBe(localDateString(d));
  });

  it("zero-pads single-digit months and days", () => {
    const d = new Date(2026, 0, 5, 12, 0, 0); // Jan 5 2026 local
    expect(localDateString(d)).toBe("2026-01-05");
  });
});
