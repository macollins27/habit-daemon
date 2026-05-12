// Task 13: Node bridge to the Python garmin shim.
//
// These tests cover two surfaces:
//
//   1. Integration tests that actually spawn `python3 scripts/garmin_fetch.py
//      --stub ...` and verify the bridge parses the canned JSON correctly.
//      These tests deliberately pass `pythonBin: 'python3'` so they do not
//      depend on the ~/.habit-daemon/venv interpreter (which only exists on
//      a fully-bootstrapped developer machine).
//
//   2. Unit tests that inject a synthetic `spawnImpl` to exercise every
//      exit-code branch (0 with data, 0 with `{}`, 1, 2, 3, and the
//      spawn-error / null-status case) plus arg-composition and the
//      default-pythonBin path. The injection point exists for testing only;
//      production code passes nothing and the default real `spawnSync` is
//      used.

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  fetchSleep,
  GarminAuthExpired,
  GarminNetworkError,
  GarminBridgeError,
  type GarminSleep,
  type SpawnResultLike,
} from "../../src/lib/garmin-adapter.js";

interface RecordedSpawn {
  readonly cmd: string;
  readonly args: readonly string[];
}

function makeRecordingSpawn(
  result: SpawnResultLike,
  recorder: { calls: RecordedSpawn[] },
): (cmd: string, args: readonly string[]) => SpawnResultLike {
  return (cmd, args) => {
    recorder.calls.push({ cmd, args: [...args] });
    return result;
  };
}

describe("fetchSleep() integration with --stub (python3)", () => {
  it("returns the full canned sleep payload when fields are omitted", async () => {
    const result = await fetchSleep({
      date: "2026-05-12",
      stub: true,
      pythonBin: "python3",
    });
    expect(result).not.toBeNull();
    const sleep = result as GarminSleep;
    expect(sleep.sleep_onset_time).toBe("2026-05-12T01:23:00");
    expect(sleep.total_sleep_minutes).toBe(412);
    expect(sleep.rem_minutes).toBe(78);
    expect(sleep.deep_sleep_minutes).toBe(65);
    expect(sleep.hrv).toBe(51.2);
  });

  it("projects only requested fields and nulls the rest", async () => {
    const result = await fetchSleep({
      date: "2026-05-12",
      stub: true,
      pythonBin: "python3",
      fields: ["hrv"],
    });
    expect(result).not.toBeNull();
    const sleep = result as GarminSleep;
    expect(sleep.hrv).toBe(51.2);
    expect(sleep.sleep_onset_time).toBeNull();
    expect(sleep.total_sleep_minutes).toBeNull();
    expect(sleep.rem_minutes).toBeNull();
    expect(sleep.deep_sleep_minutes).toBeNull();
  });
});

describe("fetchSleep() exit-code mapping (injected spawn)", () => {
  it("exit 0 with full JSON returns a GarminSleep object", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      {
        status: 0,
        stdout: JSON.stringify({
          sleep_onset_time: "2026-05-12T01:23:00",
          total_sleep_minutes: 412,
          rem_minutes: 78,
          deep_sleep_minutes: 65,
          hrv: 51.2,
        }),
        stderr: "",
      },
      recorder,
    );

    const result = await fetchSleep({
      date: "2026-05-12",
      spawnImpl,
    });
    expect(result).toEqual({
      sleep_onset_time: "2026-05-12T01:23:00",
      total_sleep_minutes: 412,
      rem_minutes: 78,
      deep_sleep_minutes: 65,
      hrv: 51.2,
    });
  });

  it("exit 0 with empty `{}` returns null (empty-data signal)", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder,
    );

    const result = await fetchSleep({
      date: "2026-05-12",
      spawnImpl,
    });
    expect(result).toBeNull();
  });

  it("exit 2 throws GarminAuthExpired and surfaces stderr in message", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 2, stdout: "", stderr: "Auth failed (token may be expired)\n" },
      recorder,
    );

    await expect(
      fetchSleep({ date: "2026-05-12", spawnImpl }),
    ).rejects.toBeInstanceOf(GarminAuthExpired);

    // Re-call to capture the actual thrown instance for message-assertion.
    let captured: unknown = null;
    try {
      await fetchSleep({ date: "2026-05-12", spawnImpl });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(GarminAuthExpired);
    expect((captured as Error).message).toMatch(/Auth failed/);
  });

  it("exit 3 throws GarminNetworkError and surfaces stderr in message", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      {
        status: 3,
        stdout: "",
        stderr: "Network or API error: ConnectionResetError\n",
      },
      recorder,
    );

    let captured: unknown = null;
    try {
      await fetchSleep({ date: "2026-05-12", spawnImpl });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(GarminNetworkError);
    expect((captured as Error).message).toMatch(/ConnectionResetError/);
  });

  it("exit 1 throws GarminBridgeError (bridge-side usage bug)", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 1, stdout: "", stderr: "--fields is required\n" },
      recorder,
    );

    let captured: unknown = null;
    try {
      await fetchSleep({ date: "2026-05-12", spawnImpl });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(GarminBridgeError);
    expect((captured as Error).message).toMatch(/usage|--fields/i);
  });

  it("status null (spawn error) throws GarminBridgeError", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      {
        status: null,
        stdout: "",
        stderr: "",
        error: new Error("ENOENT: python interpreter missing"),
      },
      recorder,
    );

    let captured: unknown = null;
    try {
      await fetchSleep({ date: "2026-05-12", spawnImpl });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(GarminBridgeError);
    expect((captured as Error).message).toMatch(/ENOENT|spawn|python/i);
  });

  it("status null with no error object still throws GarminBridgeError", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: null, stdout: "", stderr: "" },
      recorder,
    );

    let captured: unknown = null;
    try {
      await fetchSleep({ date: "2026-05-12", spawnImpl });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(GarminBridgeError);
    expect((captured as Error).message).toMatch(/unknown|spawn/i);
  });
});

describe("fetchSleep() arg composition", () => {
  it("passes --date and the full 5-field default --fields list", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder,
    );

    await fetchSleep({
      date: "2026-05-12",
      spawnImpl,
    });

    expect(recorder.calls).toHaveLength(1);
    const args = recorder.calls[0].args;
    const dateIndex = args.indexOf("--date");
    expect(dateIndex).toBeGreaterThanOrEqual(0);
    expect(args[dateIndex + 1]).toBe("2026-05-12");

    const fieldsIndex = args.indexOf("--fields");
    expect(fieldsIndex).toBeGreaterThanOrEqual(0);
    expect(args[fieldsIndex + 1]).toBe(
      "sleep_onset_time,total_sleep_minutes,rem_minutes,deep_sleep_minutes,hrv",
    );

    // No --stub flag when stub is falsy.
    expect(args).not.toContain("--stub");
  });

  it("honors a custom fields override", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder,
    );

    await fetchSleep({
      date: "2026-05-12",
      spawnImpl,
      fields: ["rem_minutes", "hrv"],
    });

    const args = recorder.calls[0].args;
    const fieldsIndex = args.indexOf("--fields");
    expect(args[fieldsIndex + 1]).toBe("rem_minutes,hrv");
  });

  it("passes --stub when stub: true", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder,
    );

    await fetchSleep({
      date: "2026-05-12",
      stub: true,
      spawnImpl,
    });

    expect(recorder.calls[0].args).toContain("--stub");
  });

  it("defaults pythonBin to ~/.habit-daemon/venv/bin/python", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder,
    );

    await fetchSleep({
      date: "2026-05-12",
      spawnImpl,
    });

    const expectedPython = resolve(
      homedir(),
      ".habit-daemon",
      "venv",
      "bin",
      "python",
    );
    // The bridge invokes /usr/bin/env <python> ..., so the python path is
    // either the cmd itself or the first arg. We accept either form so the
    // implementation can choose; the requirement is that the venv path
    // appears in the spawn invocation.
    const call = recorder.calls[0];
    const allTokens = [call.cmd, ...call.args];
    expect(allTokens).toContain(expectedPython);
  });

  it("honors a custom pythonBin override", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder,
    );

    await fetchSleep({
      date: "2026-05-12",
      spawnImpl,
      pythonBin: "/opt/custom/python3",
    });

    const call = recorder.calls[0];
    const allTokens = [call.cmd, ...call.args];
    expect(allTokens).toContain("/opt/custom/python3");
  });

  it("passes scripts/garmin_fetch.py (default scriptPath)", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder,
    );

    await fetchSleep({
      date: "2026-05-12",
      spawnImpl,
    });

    const args = recorder.calls[0].args;
    const scriptArg = args.find((a) => a.endsWith("garmin_fetch.py"));
    expect(scriptArg).toBeDefined();
    // The default scriptPath must resolve into the repo's scripts/ dir.
    expect(scriptArg).toMatch(/[\\/]scripts[\\/]garmin_fetch\.py$/);
  });

  it("honors a custom scriptPath override", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder,
    );

    await fetchSleep({
      date: "2026-05-12",
      spawnImpl,
      scriptPath: "/tmp/custom_fetch.py",
    });

    expect(recorder.calls[0].args).toContain("/tmp/custom_fetch.py");
  });
});

describe("fetchSleep() malformed stdout", () => {
  it("throws GarminBridgeError when stdout on exit 0 is not valid JSON", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "not json {{{", stderr: "" },
      recorder,
    );

    let captured: unknown = null;
    try {
      await fetchSleep({ date: "2026-05-12", spawnImpl });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(GarminBridgeError);
    expect((captured as Error).message).toMatch(/JSON|parse/i);
  });
});
