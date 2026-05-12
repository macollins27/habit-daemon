# Contributing to habit-daemon

habit-daemon is a single-user, single-host tool. The architecture is
intentionally narrow — see [`docs/decisions/`](./docs/decisions/) for
the load-bearing design choices (local-time cron, macOS + launchd
deployment, Python venv for the Garmin adapter, typed audit-log
events) before changing anything in those areas.

## Development setup

Requirements:

- Node.js 20 or newer
- Python 3.11 or newer (for the Garmin sensor adapter; see ADR 0003)
- A Discord bot and private server with the five channels listed in
  the README
- An Anthropic API key
- Optional but recommended: a Concept2 Logbook OAuth client and a
  Garmin Connect account, for end-to-end sensor verification

Bootstrap:

```sh
git clone <fork-url> habit-daemon
cd habit-daemon
pnpm install
pnpm gate          # typecheck + build + run all tests
```

The credential layout under `~/.habit-daemon/` is documented in the
[README](./README.md#configure). The repository never reads
credentials from the working tree.

## Running tests

```sh
pnpm test          # full suite, single run
pnpm test:watch    # watch mode for TDD
```

The suite is Vitest, unit-and-smoke heavy, table-driven where
practical. New features land with tests; bugfixes land with a
regression test that fails before the fix and passes after.

## Commits and branching

- **Conventional Commits** for subject lines:
  `feat: …`, `fix: …`, `refactor: …`, `chore: …`, `docs: …`, `test: …`.
  Subject under 72 characters.
- **Trunk-based development.** Work lands on `main`. No long-lived
  feature branches. Use short-lived branches for review if you want
  one, but rebase and squash before merging.
- Every commit should leave the tree in a state where `pnpm gate`
  passes. If you need to land partial work, mark it clearly in the
  commit body.

## Before changing core architecture

If your change touches the scheduler, the cron parser, the launchd
plist, the sensor adapters, or the session-event audit log, read the
relevant ADR in [`docs/decisions/`](./docs/decisions/) first. If the
change invalidates an ADR, add a new ADR superseding it in the same
PR.

## Questions and issues

Open a GitHub issue on the repository. Bug reports should include the
host OS, Node version, and the relevant slice of
`~/.habit-daemon/logs/`.
