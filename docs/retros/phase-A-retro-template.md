# Phase A Retro

**Soak window:** YYYY-MM-DD to YYYY-MM-DD

Phase A's soak runs for a minimum of 14 days with all three habits firing daily. At the end of the soak, fill in the four sections below, then read the "Changes to subsequent phase specs" section against the Phase B plan before kicking that off.

## Worked

What landed as designed. Specific behaviors observed during the soak that confirm the design's predictions.

- ...

## Failed

What didn't work, broke, or surfaced as a bug. Classify each per the soak-failure response tree in design § 6:

- **Implementation failure** — code didn't match spec. Action: re-run phase build, no spec change.
- **Design failure** — spec was wrong. Action: revise design doc, update spec, re-run.
- **Regression** — prior phase functionality broken by current phase changes. Action: roll back, isolate, fix.

For each failure: classification, what broke, root cause if known, and resolution.

- ...

## Surprised

Things the design didn't predict — positive or negative. Edge cases that emerged. User-behavior observations. Sensor-data oddities. Discord-side quirks.

- ...

## Changes to subsequent phase specs

Concrete adjustments to Phase B and Phase C plans informed by the soak. Each bullet should name a specific spec section + a specific change.

- **Phase B:** ...
- **Phase C:** ...

## Soak metrics

Fill in the actual numbers observed:

| Metric | Target | Actual | Pass? |
|--------|--------|--------|-------|
| Daemon uptime | > 99% | __% | __ |
| Scheduled fires dispatched | 100% | __% | __ |
| Vision verification accuracy | > 95% | __% | __ |
| Sensor sync success (Garmin + Concept2) | > 95% | __% | __ |
| Stage-B resolution within 24h | 100% | __% | __ |
| L3 stakes_well rotation observed | yes (or manually triggered + verified via Task 41 CLI) | __ | __ |
| L3 body_data_well firing observed (or manually triggered) | yes | __ | __ |

## Open questions for Phase B

Anything still ambiguous after the soak. Items to brainstorm or design before Phase B implementation starts.

- ...
