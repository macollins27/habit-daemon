# ADR 0001: Cron expressions are interpreted in process local time, not UTC

**Status:** Accepted
**Date:** 2026-05-12

## Context

habit-daemon is a single-user, single-host tool deployed in a single
timezone (`America/New_York`). Habit cron expressions are authored by
hand and intended to mean what they look like — `5 9 * * *` means
9:05am local, `0 22 * * 0-4` means 10:00pm local on Sun–Thu.

Many off-the-shelf cron evaluators default to UTC matching unless told
otherwise. In a single-timezone deployment, silent UTC matching would
misfire every habit by the host's UTC offset (currently 4–5 hours,
varying with DST) — and the failure mode is silent, because the daemon
would still fire crons, just at the wrong wall-clock time.

## Decision

The hand-rolled cron parser at `src/daemon/cron-parser.ts` matches
incoming `Date` values against cron expressions using local-time
`Date.prototype` accessors (`getMinutes`, `getHours`, `getDate`,
`getMonth`, `getDay`) rather than their UTC-flavored equivalents. The
fallback path that delegates to the `cron-parser` npm package omits
the `tz` option so the package defaults to the process's local
timezone.

The daemon process inherits its timezone from the host's
`/etc/localtime` (or the `TZ` environment variable if set).

## Consequences

- Cron expressions in habit definitions mean exactly what they look
  like. No translation layer, no surprise drift.
- DST transitions are handled by the host clock; cron edges that
  happen to fall in the "spring forward" or "fall back" hour behave
  the way standard cron behaves on the host OS.
- The cron engine is implicitly single-timezone. Running the daemon
  on a host with a different timezone changes the meaning of every
  cron expression in the database. This is acceptable for the current
  deployment shape but must be revisited if the system ever needs to
  serve multiple users or multiple deployment hosts.
- Tests that exercise the cron matcher must control for the host
  timezone (either by setting `TZ` in test setup or by asserting
  against local-time-equivalent inputs).

## Alternatives considered

- **Per-habit `timezone` column on `habits`.** Would future-proof for
  multi-user use but is over-engineered for a single-user deployment.
  Adds a column, validation, and serialization concern with no current
  consumer.
- **Translate cron strings to UTC at seed time.** Adds a translation
  layer at habit-creation time and forces re-translation any time the
  host timezone changes (e.g., DST). The mental model becomes "the
  cron in the database is not the cron the user wrote," which is a
  reliable source of confusion later.
- **Run the daemon process under `TZ=UTC` and translate at the
  scheduling boundary.** Same complexity cost as the previous option,
  with the additional cost that log timestamps would all be in UTC and
  would need translation for human reading.
