import { describe, it, expect } from "vitest";
import {
  parseMorningRowConfig,
  parseWindDownConfig,
} from "../../src/orchestrate/proof-config.js";

describe("parseMorningRowConfig", () => {
  it("returns the parsed config for valid input", () => {
    const json = JSON.stringify({ min_minutes: 20 });
    expect(parseMorningRowConfig(json, "habit-1")).toEqual({
      min_minutes: 20,
    });
  });

  it("throws an error including the habit id when min_minutes is missing or non-numeric", () => {
    const json = JSON.stringify({ min_minutes: "twenty" });
    expect(() => parseMorningRowConfig(json, "habit-xyz")).toThrow(
      /habit habit-xyz.*min_minutes/,
    );
  });
});

describe("parseWindDownConfig", () => {
  it("returns the parsed config for valid input", () => {
    const json = JSON.stringify({ stage_b_threshold: "22:30" });
    expect(parseWindDownConfig(json, "habit-1")).toEqual({
      stage_b_threshold: "22:30",
    });
  });

  it("throws an error including the habit id when stage_b_threshold is missing or non-string", () => {
    const json = JSON.stringify({ stage_b_threshold: 2230 });
    expect(() => parseWindDownConfig(json, "habit-xyz")).toThrow(
      /habit habit-xyz.*stage_b_threshold/,
    );
  });
});
