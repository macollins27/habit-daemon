// Regression coverage for the user-habit channel-routing fallback in
// `src/orchestrate/habit-checkin.ts`.
//
// Bug being guarded against (latent crash before this fix):
//
//   `channelForDomain(domain)` consulted a closed
//   `{row, strength, wind-down}` map and threw on any other value. The
//   `createHabit` orchestrator seeds `habits.domain` with the user-supplied
//   slug (see src/orchestrate/create-habit.ts:94), so the first scheduler
//   tick on any user-created habit would crash inside this verb.
//
// The fix widens the lookup to take the full habit row and fall back to
// `habit.channel_id` (a raw Discord snowflake) when the domain isn't in the
// Phase-A map. `postToChannel` accepts either a `ChannelName` or a raw
// snowflake string and routes accordingly.

import { describe, it, expect } from "vitest";

import { channelForHabit } from "../../src/orchestrate/habit-checkin.js";

describe("channelForHabit() — Phase-A domains", () => {
  it("morning-row domain ('row') resolves to ChannelName 'morning-row'", () => {
    expect(
      channelForHabit({ domain: "row", channel_id: "ignored-1" }),
    ).toBe("morning-row");
  });

  it("strength domain resolves to ChannelName 'strength'", () => {
    expect(
      channelForHabit({ domain: "strength", channel_id: "ignored-2" }),
    ).toBe("strength");
  });

  it("wind-down domain resolves to ChannelName 'wind-down'", () => {
    expect(
      channelForHabit({ domain: "wind-down", channel_id: "ignored-3" }),
    ).toBe("wind-down");
  });
});

describe("channelForHabit() — user-created habit fallback", () => {
  it("returns the row's channel_id snowflake when the domain is not in the map", () => {
    // `createHabit` writes `habits.domain = input.slug`. A user-created
    // habit with slug 'evening-walk' lands as domain='evening-walk', which
    // is NOT in DOMAIN_TO_CHANNEL. The fallback path returns the snowflake
    // verbatim so `postToChannel` can pass it through to
    // `client.channels.fetch` without a registry lookup.
    const snowflake = "1234567890123456789";
    expect(
      channelForHabit({ domain: "evening-walk", channel_id: snowflake }),
    ).toBe(snowflake);
  });

  it("does not throw on an unknown domain (the pre-fix crash path)", () => {
    expect(() =>
      channelForHabit({ domain: "any-user-slug", channel_id: "snowflake-1" }),
    ).not.toThrow();
  });

  it("returns channel_id verbatim — does not transform, trim, or validate the snowflake", () => {
    // Whatever the user supplied via the API survives intact; validation
    // and normalization happen at the input boundary (api/schemas.ts),
    // not in the router.
    const oddButNonEmpty = "  9999-not-a-real-id  ";
    expect(
      channelForHabit({ domain: "weird-slug", channel_id: oddButNonEmpty }),
    ).toBe(oddButNonEmpty);
  });
});
