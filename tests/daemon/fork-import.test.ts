import { describe, it, expect } from "vitest";
import { schedulerTick } from "../../src/daemon/scheduler.js";
import { dispatchClaude } from "../../src/daemon/sdk-dispatch.js";
import { SessionStore } from "../../src/daemon/session-store.js";

describe("forked daemon modules", () => {
  it("imports without error", () => {
    expect(schedulerTick).toBeDefined();
    expect(dispatchClaude).toBeDefined();
    expect(SessionStore).toBeDefined();
  });
});
