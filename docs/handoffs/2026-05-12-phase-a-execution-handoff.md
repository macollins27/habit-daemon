# Phase A execution handoff — habit-daemon

**For:** The Claude instance opening this repo to execute Phase A.
**From:** The brainstorming + writing-plans session that produced the design and plan.
**Status:** Authority docs committed. Implementation has not yet begun.

---

## What you're inheriting

Three commits in this repo. Read them in order:

```
24490c3  docs(plan): Phase A implementation plan, 42 tasks, TDD-cycle per task
188de54  docs(design): add proof_rejection_callout_due column to habit_runs
71042cd  docs(habit-daemon): initial design doc, 6 sections locked
```

These are **authority documents**. The design and plan were validated
section-by-section through brainstorming with the founder. Every section
was challenged, refined, and locked. The plan was reviewed for scope
smuggling before commit. **Do not redesign. Do not refactor the spec.
Execute it.**

If you find a real architectural issue while implementing, write a retro
note in `docs/retros/` flagging the issue. Do not silently change the spec
in code.

---

## Required reading (in order, before you do anything else)

1. `docs/plans/2026-05-12-habit-daemon-design.md` — the full design (6
   sections, ~900 lines). Read it end to end. Sections 1–6 are the contract
   you implement against.
2. `docs/plans/2026-05-12-phase-a-implementation.md` — your 42-task work
   plan. Tier 1 → Tier 10. TDD cycle universalized at the top; per-task
   bodies show files, behavior, tests, and commit messages.
3. `/Users/maxwellcollins/Developer/Property-Linkware-v2.1/scripts/` — the
   PLW v1 daemon files you will fork in Task 3. Specifically:
   `scheduler-daemon.ts`, `scheduler.ts`, `cron-parser.ts`,
   `sdk-dispatch.ts`, `session-store.ts`, `ledger.ts`, `kill-switch.ts`,
   `verify-footer.ts`, `heartbeat.ts`, `aat-chain.ts`. Read them
   end-to-end before Task 3 so your fork preserves the daemon discipline.

You may also reference the user's global rules at `~/.claude/CLAUDE.md` and
`~/.claude/rules/typescript/*.md`. They apply.

---

## How to execute

Use the **`superpowers:subagent-driven-development`** skill. The pattern:

1. Read the next pending task in the plan.
2. Dispatch a fresh subagent with a self-contained brief (the task body +
   the design-doc references it depends on).
3. Subagent writes the failing test, runs it, implements, runs it,
   typechecks, commits.
4. You review the subagent's diff before considering the task done. Do
   not patch their work yourself — dispatch a fixer subagent if something
   is wrong.
5. Move to next task.

If a subagent returns work that contradicts the design doc, dispatch a
fixer subagent. Do not let drift accumulate.

Each task ends in one conventional commit. Forty-two tasks = forty-two
commits on `main` after this handoff is itself committed.

---

## Pre-Phase-A logistics (manual, before Task 1 starts)

These are NOT Phase A tasks. They are credentials and one-time setup the
founder must complete in person. Surface them at session start; do not
attempt to execute them yourself:

1. **Discord bot.** Register at https://discord.com/developers/applications.
   Create application, generate bot token. Add bot to private server with
   permissions: Manage Channels, Send Messages, Read Message History, Embed
   Links, Attach Files, Add Reactions. Capture: `DISCORD_BOT_TOKEN` and
   channel IDs for `#morning-row`, `#strength`, `#wind-down`, `#wins`,
   `#sunday-review`.
2. **Concept2 OAuth client.** Register at https://log-dev.concept2.com.
   Capture `CLIENT_ID` and `CLIENT_SECRET`. Write to
   `~/.habit-daemon/concept2-credentials.json` (mode 0600).
3. **Python + garminconnect.** `pip install garminconnect` (Python 3.11+).
4. **Garmin login.** After Task 12 (when `scripts/garmin_fetch.py` exists),
   run `python scripts/garmin_fetch.py --login` interactively to complete
   the MFA flow and seed `~/.garminconnect/` token cache.
5. **Environment file.** `~/.habit-daemon/env` with the variables listed
   at the bottom of the plan document.

Confirm with the founder before Task 1 which of these are already done.

---

## Discipline (non-negotiable)

These are the patterns the brainstorming session locked. They are not
negotiable mid-implementation:

- **No time estimates.** Anywhere. Not in commit messages, not in retros,
  not in task notes. Cost framing is not Claude Code's input. Only
  correctness is.
- **No phase-within-phase.** If a Phase A task feels dense, that's because
  Phase A is dense. Do not invent Phase A.1 / A.2 sub-phases. Execute the
  task as specified.
- **TDD first, always.** Failing test before implementation. Every task.
- **Conventional commits.** `feat:`, `fix:`, `test:`, `docs:`, `chore:`,
  `refactor:`. Subject line < 72 chars. Body explains what + why, not how.
- **No commit attribution lines.** Co-Authored-By is disabled globally
  per the founder's settings. Do not add it.
- **No `--no-verify`, no `--no-gpg-sign`, no skipping hooks.** If a hook
  fails, fix the underlying issue.
- **Authority docs precede code.** This is the precedent established by
  the three commits in this repo. Maintain it: any new design decision
  goes into a doc commit before the implementation commit that follows.
- **Forked-from-PLW provenance** must be preserved in every PLW-forked
  file via the header comment specified in Task 3 (`Forked from
  Property-Linkware-v2.1/scripts/<original-path> at PLW commit v1. Diverges
  from this point. Do not auto-sync.`).
- **No emojis in source code or commit messages** unless the user
  explicitly requests them in a habit message template. Vision-channel
  posts use `✓` for completions (already specified in design § 5).
- **No scope smuggling.** If you find yourself wanting to "defer X to a
  later phase," stop. Write a retro note instead. The design committee
  (you and the founder) reviews scope changes; subagents executing tasks
  do not get to defer.

---

## Voice rules for any messages the system will send

(These apply to Discord messages the bot generates, not to your own
output. The plan tasks reference them; this is a quick recap.)

- Plain English. No hype.
- No "world-class," "next-gen," "AI-powered," "transformative," or
  similar marketing register.
- First-person plural ("we") when speaking about Code Rescue or the
  systems. First-person singular ("I") for the bot's own perspective
  inside Discord messages is fine.
- Numbers are load-bearing. Quantitative claims preferred over
  adjectives.
- Mechanism described, not metaphor.
- American English.
- No emojis in bot messages except the `✓` mark in `#wins` posts.

---

## Completion criteria (Phase A is done when)

The plan's "Phase A completion gate" lists this in full. Recap:

- All 42 tasks committed.
- `pnpm gate` (typecheck + build + tests) green.
- systemd unit installed, daemon running, watchdog observable.
- **14-day minimum** real-world soak run with all three habits firing
  daily. Soak meets criteria from design doc §6:
  - daemon uptime > 99%
  - all scheduled fires dispatched
  - vision verification accuracy > 95%
  - sensor sync success > 95%
  - stage-B resolution 100% within 24h
  - L3 stakes_well rotation observed (or manually triggered via Task 41
    and verified)
  - L3 body_data_well firing observed when sensor anomalies present (or
    manually triggered + verified)
- Retro written to `docs/retros/phase-A-retro.md` using the template from
  Task 42, with structure: Worked / Failed / Surprised / Changes to
  subsequent phase specs.

When complete, return control to the founder. Do **not** auto-start
Phase B. Phase B's plan is drafted after the Phase A retro is read.

---

## What to do at session start

1. Read the three required-reading docs end-to-end.
2. Print a one-paragraph summary back to the founder confirming you
   understand the design, the plan, and the discipline rules.
3. Ask the founder which of the pre-Phase-A logistics items (Discord bot,
   Concept2, Python, Garmin login, env file) are already done.
4. For each not-yet-done logistics item, give the founder the exact
   commands or URLs.
5. Once logistics are done, invoke `superpowers:subagent-driven-development`
   and begin with Task 1.

---

## What to do if blocked

- If a subagent returns work that doesn't compile, doesn't pass tests, or
  contradicts the design: dispatch a fixer subagent with specific feedback.
  Do not patch their work yourself.
- If you discover a design ambiguity that the plan doesn't resolve:
  pause execution, write the question to the founder, wait for the answer
  before proceeding. The design doc is the source of truth; ambiguities
  in the doc need founder-level resolution.
- If a third-party service is down (Garmin auth, Concept2 OAuth callback,
  Discord rate-limit): retry per the design's failure-handling rules. Do
  not work around the failure mode with self-report fallbacks (the design
  explicitly forbids this for sensor data).
- If you finish all 42 tasks and the soak fails: classify the failure per
  the soak-failure response tree in design §6 (implementation / design /
  regression), write the retro, then dispatch the right kind of follow-up.

---

*End of handoff. The design is committed, the plan is committed, the
provenance is recorded. Execute.*
