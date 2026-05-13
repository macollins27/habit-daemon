import { describe, it, expect } from "vitest";
import { schedulerTick } from "../../src/daemon/scheduler.js";
import { dispatchClaude } from "../../src/daemon/sdk-dispatch.js";
import { SessionStore } from "../../src/daemon/session-store.js";
import { startServer } from "../../src/api/server.js";

describe("forked daemon modules", () => {
  it("imports without error", () => {
    expect(schedulerTick).toBeDefined();
    expect(dispatchClaude).toBeDefined();
    expect(SessionStore).toBeDefined();
    // The HTTP API is imported and wired by scheduler-daemon.ts's main()
    // — verifying the export survives forked-import here keeps the
    // daemon-time module graph tested without booting a real server.
    expect(startServer).toBeDefined();
    expect(typeof startServer).toBe("function");
  });
});
