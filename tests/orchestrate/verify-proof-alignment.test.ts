// verifyAlignmentText sub-verb tests — proof_type = alignment_text.
//
// The sub-verb judges the inbound message's free text via verifyAlignment
// (Claude, injected here) and maps the verdict to a VerifyProofResult:
//   accepted → completed (which the caller turns into status='completed',
//              next_escalation_at=NULL — i.e. the texts stop)
//   rejected → rejected.
//
// The sub-verb performs no DB writes; only ctx.message.content is read, so the
// context is constructed minimally.

import { describe, it, expect } from "vitest";
import type { Message } from "discord.js";
import { makeVerifyAlignmentText } from "../../src/orchestrate/verify-proof.js";
import type { SubVerbContext } from "../../src/orchestrate/verify-proof.js";

const FULL_PASS = {
  avoiding: { addressed: true, substantive: true },
  start: { addressed: true, substantive: true },
  wins: { addressed: true, count: 3, substantive: true },
  interfering: { addressed: true, substantive: true },
  rejection_reason: "",
};

function ctxWith(content: string): SubVerbContext {
  return {
    message: { content } as unknown as Message,
  } as unknown as SubVerbContext;
}

describe("verifyAlignmentText sub-verb", () => {
  it("returns completed for a substantive submission", async () => {
    const verb = makeVerifyAlignmentText({
      dispatchImpl: async () => ({ structured_output: FULL_PASS }),
    });
    const result = await verb(
      ctxWith(
        "Avoiding: call billing. Start: run tests. Wins: 1 meal 2 walk 3 ship. Interfering: AI first.",
      ),
    );
    expect(result.outcome).toBe("completed");
    expect((result.proofPayload as { source: string }).source).toBe(
      "alignment_text",
    );
  });

  it("returns rejected for a vague submission", async () => {
    const verb = makeVerifyAlignmentText({
      dispatchImpl: async () => ({
        structured_output: {
          ...FULL_PASS,
          avoiding: { addressed: true, substantive: false },
          rejection_reason: "too vague",
        },
      }),
    });
    const result = await verb(ctxWith("Avoiding: life. Start: stuff. Wins: x. Interfering: stuff."));
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBeTruthy();
  });
});
