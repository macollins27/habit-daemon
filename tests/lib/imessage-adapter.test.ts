import { describe, it, expect, vi } from "vitest";
import {
  buildOsascriptArgs,
  maskPhone,
  sendText,
  type OsascriptOutcome,
  type OsascriptRunner,
} from "../../src/lib/imessage-adapter.js";

describe("buildOsascriptArgs", () => {
  it("passes the phone and body as bound argv values, not interpolated into the script", () => {
    const phone = "+18135551234";
    const body = '"; do shell script "rm -rf ~"'; // a hostile body
    const args = buildOsascriptArgs(phone, body);

    expect(args[0]).toBe("-e");
    // The script source is args[1]; phone/body are the trailing run-handler args.
    expect(args[2]).toBe(phone);
    expect(args[3]).toBe(body);
    expect(args).toHaveLength(4);
  });

  it("never splices the body into the AppleScript source (injection-safety)", () => {
    const body = "send badness to everyone";
    const args = buildOsascriptArgs("+1555", body);
    const script = args[1] as string;
    expect(script).toContain("iMessage");
    expect(script).toContain("on run {targetPhone, targetBody}");
    // The hostile/body text must not appear in the executable script body.
    expect(script).not.toContain(body);
  });
});

describe("maskPhone", () => {
  it("keeps only the last four digits", () => {
    expect(maskPhone("+18135551234")).toBe("••••••••1234");
  });

  it("fully masks short values", () => {
    expect(maskPhone("123")).toBe("•••");
    expect(maskPhone("")).toBe("");
  });
});

describe("sendText", () => {
  const okRunner: OsascriptRunner = async (): Promise<OsascriptOutcome> => ({
    code: 0,
    stderr: "",
  });

  it("returns ok and calls the runner with the phone+body argv on success", async () => {
    const runner = vi.fn(okRunner);
    const result = await sendText(
      { to: "+18135551234", body: "checkpoint" },
      { runner },
    );

    expect(result.ok).toBe(true);
    expect(runner).toHaveBeenCalledOnce();
    const args = runner.mock.calls[0]![0];
    expect(args[2]).toBe("+18135551234");
    expect(args[3]).toBe("checkpoint");
  });

  it("fails closed (no runner call) when the destination is empty", async () => {
    const runner = vi.fn(okRunner);
    const result = await sendText({ to: "", body: "x" }, { runner });

    expect(result.ok).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails closed (no runner call) when the body is empty", async () => {
    const runner = vi.fn(okRunner);
    const result = await sendText({ to: "+1555", body: "" }, { runner });

    expect(result.ok).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns ok:false with a masked number when osascript exits non-zero", async () => {
    const runner: OsascriptRunner = async () => ({
      code: 1,
      stderr: "Messages got an error: not authorized",
    });
    const result = await sendText(
      { to: "+18135551234", body: "checkpoint" },
      { runner },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("•••••••1234");
    expect(result.error).not.toContain("8135551234");
    expect(result.error).toContain("not authorized");
  });

  it("returns ok:false (never throws) when the runner throws", async () => {
    const runner: OsascriptRunner = async () => {
      throw new Error("spawn osascript ENOENT");
    };
    const result = await sendText(
      { to: "+18135551234", body: "checkpoint" },
      { runner },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOENT");
    expect(result.error).toContain("•••••••1234");
  });
});
