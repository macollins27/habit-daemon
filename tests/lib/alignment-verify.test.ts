import { describe, it, expect } from "vitest";
import {
  verifyAlignment,
  type DispatchResult,
} from "../../src/lib/alignment-verify.js";

type Dispatch = (opts: {
  prompt: string;
  jsonSchema: string;
}) => Promise<DispatchResult>;

/** A judge that returns a fixed structured verdict, ignoring the prompt. */
function fixedJudge(structured: unknown): Dispatch {
  return async () => ({ structured_output: structured });
}

const FULL_PASS = {
  avoiding: { addressed: true, substantive: true },
  start: { addressed: true, substantive: true },
  wins: { addressed: true, count: 3, substantive: true },
  interfering: { addressed: true, substantive: true },
  rejection_reason: "",
};

describe("verifyAlignment", () => {
  it("accepts a substantive four-question submission with 3 wins", async () => {
    const result = await verifyAlignment({
      text: "Avoiding: calling the billing office. Start: open the repo and run tests. Wins: 1) eat a real meal 2) walk 10 min 3) ship the fix. Interfering: opening AI before deciding the day.",
      dispatchImpl: fixedJudge(FULL_PASS),
    });
    expect(result.accepted).toBe(true);
    expect(result.parsed).toEqual(FULL_PASS);
  });

  it("rejects when an answer is not substantive (vague)", async () => {
    const verdict = {
      ...FULL_PASS,
      avoiding: { addressed: true, substantive: false },
      rejection_reason: "‘avoiding’ is too vague — name a concrete action",
    };
    const result = await verifyAlignment({
      text: "Avoiding: life. Start: walk. Wins: 1 2 3. Interfering: phone.",
      dispatchImpl: fixedJudge(verdict),
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/vague/i);
  });

  it("rejects when fewer than three wins are listed", async () => {
    const verdict = {
      ...FULL_PASS,
      wins: { addressed: true, count: 2, substantive: true },
      rejection_reason: "",
    };
    const result = await verifyAlignment({
      text: "Avoiding: X. Start: Y. Wins: 1) a 2) b. Interfering: Z.",
      dispatchImpl: fixedJudge(verdict),
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/three concrete wins.*got 2/i);
  });

  it("fails closed on an empty submission without dispatching", async () => {
    let called = false;
    const result = await verifyAlignment({
      text: "   ",
      dispatchImpl: async () => {
        called = true;
        return { structured_output: FULL_PASS };
      },
    });
    expect(result.accepted).toBe(false);
    expect(called).toBe(false);
  });

  it("fails closed when the judge dispatch errors", async () => {
    const result = await verifyAlignment({
      text: "a real attempt with all four answers",
      dispatchImpl: async () => ({ error: "claude -p exited 1" }),
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/judge failed/i);
  });

  it("fails closed when the judge returns no structured output", async () => {
    const result = await verifyAlignment({
      text: "a real attempt",
      dispatchImpl: async () => ({}),
    });
    expect(result.accepted).toBe(false);
  });

  it("fails closed when the verdict doesn't match the schema", async () => {
    const result = await verifyAlignment({
      text: "a real attempt",
      dispatchImpl: fixedJudge({ avoiding: "nope" }),
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/schema validation failed/i);
  });
});
