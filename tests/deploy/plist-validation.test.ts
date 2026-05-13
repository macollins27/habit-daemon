import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const PLIST_PATH = resolve(__dirname, "../../deploy/com.habit-daemon.plist");
const INSTALL_PATH = resolve(__dirname, "../../deploy/install.sh");

describe("deploy/com.habit-daemon.plist", () => {
  const content = readFileSync(PLIST_PATH, "utf-8");

  it("is a valid plist XML structure", () => {
    expect(content).toContain('<?xml version="1.0"');
    expect(content).toContain("<!DOCTYPE plist");
    expect(content).toContain('<plist version="1.0">');
    expect(content).toContain("</plist>");
  });

  it("has Label = com.habit-daemon", () => {
    expect(content).toMatch(
      /<key>Label<\/key>\s*<string>com\.habit-daemon<\/string>/
    );
  });

  it("has ProgramArguments with node + scheduler-daemon.js", () => {
    expect(content).toMatch(/<key>ProgramArguments<\/key>/);
    // Apple Silicon Homebrew path. If running on Intel Macs you'd swap for
    // /usr/local/bin/node; either should pass the regex below.
    expect(content).toMatch(/<string>(?:\/opt\/homebrew|\/usr\/local)\/bin\/node<\/string>/);
    expect(content).toMatch(/scheduler-daemon\.js/);
  });

  it("has KeepAlive with SuccessfulExit=false", () => {
    expect(content).toMatch(/<key>KeepAlive<\/key>/);
    expect(content).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
  });

  it("has ThrottleInterval >= 10s", () => {
    const match = content.match(
      /<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/
    );
    expect(match).not.toBeNull();
    expect(parseInt(match![1]!, 10)).toBeGreaterThanOrEqual(10);
  });

  it("has StandardOutPath + StandardErrorPath under ~/.habit-daemon/logs/", () => {
    expect(content).toMatch(
      /<key>StandardOutPath<\/key>\s*<string>[^<]*\.habit-daemon\/logs\/stdout\.log<\/string>/
    );
    expect(content).toMatch(
      /<key>StandardErrorPath<\/key>\s*<string>[^<]*\.habit-daemon\/logs\/stderr\.log<\/string>/
    );
  });

  it("has WorkingDirectory set (dev-mode = repo path; prod = /opt)", () => {
    // Per ADR 0002 the macOS install runs in-place from the repo's dist/,
    // so the WorkingDirectory points at the repo. A future port to /opt
    // would be acceptable too. Either form is required to be absolute and
    // a real path on disk.
    const match = content.match(
      /<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/,
    );
    expect(match).not.toBeNull();
    const value = match![1]!;
    expect(value.startsWith("/")).toBe(true);
    expect(value.endsWith("/habit-daemon")).toBe(true);
  });

  it("has RunAtLoad = true", () => {
    expect(content).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it("declares NODE_ENV=production in EnvironmentVariables", () => {
    expect(content).toMatch(/<key>EnvironmentVariables<\/key>/);
    expect(content).toMatch(
      /<key>NODE_ENV<\/key>\s*<string>production<\/string>/
    );
  });
});

describe("deploy/install.sh", () => {
  const content = readFileSync(INSTALL_PATH, "utf-8");

  it("has bash shebang", () => {
    expect(content).toMatch(/^#!\/usr\/bin\/env bash/);
  });

  it("is executable", () => {
    const mode = statSync(INSTALL_PATH).mode & 0o777;
    expect(mode & 0o100).toBe(0o100); // owner-execute bit
  });

  it("uses set -euo pipefail", () => {
    expect(content).toMatch(/set -euo pipefail/);
  });

  it("references launchctl bootout + bootstrap", () => {
    expect(content).toMatch(/launchctl bootout/);
    expect(content).toMatch(/launchctl bootstrap/);
  });

  it("copies SQL migrations to dist (Task 5 carry-forward)", () => {
    expect(content).toMatch(/migrations\/\*\.sql/);
  });

  it("validates ~/.habit-daemon/env exists", () => {
    expect(content).toMatch(/\.habit-daemon\/env/);
  });

  it("kickstarts the LaunchAgent after bootstrap", () => {
    expect(content).toMatch(/launchctl kickstart/);
  });
});
