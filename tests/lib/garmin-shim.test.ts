import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { statSync } from "node:fs";

const SCRIPT = resolve(process.cwd(), "scripts/garmin_fetch.py");
const ALL_FIELDS =
  "sleep_onset_time,total_sleep_minutes,rem_minutes,deep_sleep_minutes,hrv";

describe("scripts/garmin_fetch.py --stub", () => {
  it("returns full canned JSON when all fields requested", () => {
    const result = spawnSync(
      "python3",
      [SCRIPT, "--stub", "--date", "2026-05-12", "--fields", ALL_FIELDS],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sleep_onset_time).toBe("2026-05-12T01:23:00");
    expect(parsed.total_sleep_minutes).toBe(412);
    expect(parsed.rem_minutes).toBe(78);
    expect(parsed.deep_sleep_minutes).toBe(65);
    expect(parsed.hrv).toBe(51.2);
  });

  it("projects only requested fields", () => {
    const result = spawnSync(
      "python3",
      [SCRIPT, "--stub", "--date", "2026-05-12", "--fields", "rem_minutes"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed)).toEqual(["rem_minutes"]);
    expect(parsed.rem_minutes).toBe(78);
  });

  it("trims whitespace in --fields list", () => {
    const result = spawnSync(
      "python3",
      [
        SCRIPT,
        "--stub",
        "--date",
        "2026-05-12",
        "--fields",
        " rem_minutes , hrv ",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed).sort()).toEqual(["hrv", "rem_minutes"]);
  });

  it("--stub with --date but no --fields returns the full default set", () => {
    const result = spawnSync(
      "python3",
      [SCRIPT, "--stub", "--date", "2026-05-12"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sleep_onset_time).toBe("2026-05-12T01:23:00");
    expect(parsed.total_sleep_minutes).toBe(412);
    expect(parsed.rem_minutes).toBe(78);
    expect(parsed.deep_sleep_minutes).toBe(65);
    expect(parsed.hrv).toBe(51.2);
  });

  it("exits 1 on usage error when no mode given", () => {
    const result = spawnSync("python3", [SCRIPT], { encoding: "utf8" });
    expect(result.status).toBe(1);
  });

  it("exits 1 when --stub given without --date", () => {
    const result = spawnSync("python3", [SCRIPT, "--stub"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--date/);
  });

  it("script file is executable", () => {
    const stat = statSync(SCRIPT);
    // owner-execute bit set
    expect(stat.mode & 0o100).toBe(0o100);
  });
});
