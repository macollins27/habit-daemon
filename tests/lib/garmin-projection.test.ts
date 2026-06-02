import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const VENV_PYTHON = `${process.env.HOME}/.habit-daemon/venv/bin/python`;
const SCRIPT_PATH = join(process.cwd(), "scripts/garmin_fetch.py");
const FIXTURE_PATH = join(process.cwd(), "tests/fixtures/garmin/sleep-response-real.json");

if (!existsSync(VENV_PYTHON)) {
  describe.skip("garmin_fetch.py projection — venv not available", () => {
    it("skipped", () => undefined);
  });
} else {
  describe("garmin_fetch.py --from-file projection", () => {
    it("projects real Garmin DTO fields into daemon-side names", () => {
      const result = spawnSync(
        VENV_PYTHON,
        [
          SCRIPT_PATH,
          "--from-file", FIXTURE_PATH,
          "--date", "2026-05-13",
          "--fields", "sleep_onset_time,total_sleep_minutes,rem_minutes,deep_sleep_minutes",
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      const projected = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(typeof projected.sleep_onset_time).toBe("string");
      expect(projected.sleep_onset_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(typeof projected.total_sleep_minutes).toBe("number");
      expect(projected.total_sleep_minutes).toBeGreaterThan(0);
      expect(typeof projected.rem_minutes).toBe("number");
      expect(typeof projected.deep_sleep_minutes).toBe("number");
    });

    it("projects only the requested subset", () => {
      const result = spawnSync(
        VENV_PYTHON,
        [SCRIPT_PATH, "--from-file", FIXTURE_PATH, "--date", "2026-05-13", "--fields", "sleep_onset_time"],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      const projected = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(Object.keys(projected)).toEqual(["sleep_onset_time"]);
    });

    it("returns empty when raw has no dailySleepDTO", () => {
      // Write a temp empty fixture inline.
      const fs = require("node:fs") as typeof import("node:fs");
      const tmpPath = "/tmp/garmin-empty-fixture.json";
      fs.writeFileSync(tmpPath, "{}");
      try {
        const result = spawnSync(
          VENV_PYTHON,
          [SCRIPT_PATH, "--from-file", tmpPath, "--date", "2026-05-13", "--fields", "sleep_onset_time"],
          { encoding: "utf8" },
        );
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({});
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });

    it("pins the projection contract against the captured fixture", () => {
      // The captured fixture's dailySleepDTO produces a known set of daemon-side
      // values. If Garmin's DTO field names change OR the projection logic
      // changes, this test breaks loudly with the actual mismatch.
      const result = spawnSync(
        VENV_PYTHON,
        [
          SCRIPT_PATH, "--from-file", FIXTURE_PATH, "--date", "2026-05-13",
          "--fields", "sleep_onset_time,total_sleep_minutes,rem_minutes,deep_sleep_minutes",
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      const projected = JSON.parse(result.stdout) as Record<string, unknown>;
      // Captured 2026-05-13: 7:03 hours sleep, onset 01:41 local.
      expect(projected.sleep_onset_time).toBe("2026-05-13T01:41:12");
      expect(projected.total_sleep_minutes).toBe(423);
      expect(projected.rem_minutes).toBe(56);
      expect(projected.deep_sleep_minutes).toBe(92);
    });
  });
}
