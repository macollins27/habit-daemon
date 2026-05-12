# Forked-from-PLW provenance

The files under `src/daemon/` (with the exception of any net-new code that
lands later) are forked from Property-Linkware-v2.1's daemon orchestrator.

**Source:** `/Users/maxwellcollins/Developer/Property-Linkware-v2.1`
**Fork commit:** `26c8c049` (PLW HEAD as of 2026-05-12)
**Fork date:** 2026-05-12

## Files forked

(11 files — see per-file header comments for the original PLW source path.)

- `src/daemon/scheduler-daemon.ts` ← `scripts/orchestrate/scheduler-daemon.ts`
- `src/daemon/scheduler.ts` ← `scripts/lib/orchestrator/scheduler.ts`
- `src/daemon/cron-parser.ts` ← `scripts/lib/orchestrator/cron-parser.ts`
- `src/daemon/sdk-dispatch.ts` ← `scripts/lib/orchestrator/sdk-dispatch.ts`
- `src/daemon/session-store.ts` ← `scripts/lib/orchestrator/session-store.ts`
- `src/daemon/ledger.ts` ← `scripts/lib/orchestrator/ledger.ts`
- `src/daemon/kill-switch.ts` ← `scripts/lib/orchestrator/kill-switch.ts`
- `src/daemon/verify-footer.ts` ← `scripts/lib/orchestrator/verify-footer.ts`
- `src/daemon/heartbeat.ts` ← `scripts/lib/orchestrator/heartbeat.ts`
- `src/daemon/aat-chain.ts` ← `scripts/lib/orchestrator/aat-chain.ts`
- `src/daemon/footer-schema.ts` ← `scripts/lib/orchestrator/footer-schema.ts`

## Divergence policy

Habit-daemon and PLW v2 share an ancestral commit but evolve independently
from this point. No auto-sync, no backport pipeline. PLW's daemon
discipline informs the design; PLW's code is reused only where it transfers
cleanly.

Known initial divergences (see `docs/retros/phase-A-divergences.md`):

1. PLW fork file count was undercounted by 1 — `footer-schema.ts` is the
   11th file (verify-footer.ts dependency).
2. PLW fork is a structural copy, not drop-in — adaptation of PLW-specific
   satellites (PLW_* env vars, `bin/plw` binary, sandbox path) happens
   per-task at point of activation, not in this commit.
3. `cron-parser.ts` matches against LOCAL time (America/New_York), not UTC.

Subsequent divergences (PLW_* → HABIT_* renames, in-process verb dispatch
replacing `bin/plw` spawn, etc.) will be logged as they land.
