# Architectural Decision Records

This directory captures the load-bearing architectural decisions made
during habit-daemon's build. Each ADR is a short, dated, statused
markdown file with Context / Decision / Consequences / Alternatives.

Read these to understand *why* the codebase is shaped the way it is
before changing the corresponding code.

## Index

- [ADR 0001: Cron expressions are interpreted in process local time, not UTC](./0001-local-time-cron-interpretation.md)
- [ADR 0002: Deployment target is macOS with launchd, not Linux with systemd](./0002-macos-launchd-deployment.md)
- [ADR 0003: The Python sensor adapter runs in a project-local venv at `~/.habit-daemon/venv`](./0003-python-venv-for-sensor-adapter.md)
- [ADR 0004: Audit-log events are tagged with a typed event_type column + SQL CHECK enforcement](./0004-event-type-check-constraint.md)

## Adding a new ADR

1. Copy the most recent ADR as a template.
2. Increment the numeric prefix (zero-padded, e.g., `0005-`).
3. Fill in the Context / Decision / Consequences / Alternatives.
4. Set Status: `Accepted` (or `Proposed`, `Deprecated`, `Superseded`).
5. Add an entry to the Index above.
