# ADR 0003: The Python sensor adapter runs in a project-local venv at `~/.habit-daemon/venv`

**Status:** Accepted
**Date:** 2026-05-12

## Context

The `wind-down` habit is verified against Garmin Connect sleep data.
The canonical Python client for Garmin Connect is the `garminconnect`
package on PyPI; there is no first-party TypeScript equivalent and the
unofficial JavaScript ports are intermittently maintained.

On modern macOS with Homebrew Python 3.12, PEP 668 ("Marking Python
base environments as externally managed") makes the system / Homebrew
interpreter refuse `pip install garminconnect` and even
`pip install --user garminconnect` — installs outside a virtual
environment exit with `error: externally-managed-environment`. The
older system Python (3.9.x on current macOS) is too old for the
library's runtime requirements.

This leaves three places the Python dependency could live: a venv, a
container, or a rewrite of the library in TypeScript.

## Decision

A project-local virtual environment is created at
`~/.habit-daemon/venv/` and the `garminconnect` package (plus its
transitive dependencies) is installed into it. The Node-side bridge
(`src/lib/garmin-adapter.ts`) invokes the venv's interpreter
explicitly, resolving the path at call time as
`os.homedir() + '/.habit-daemon/venv/bin/python'`. The Python fetch
script may pin the interpreter via a wrapper or shebang, but callers
must not rely on a bare `python3` resolving to the right interpreter.

The venv lives under `~/.habit-daemon/`, alongside the other
host-local credential and runtime artifacts (the `env` file, the
Concept2 OAuth credentials and tokens, and the Garmin token cache).
The repository contains the Python script and a setup procedure but
never assumes a system-wide `garminconnect` install.

## Consequences

- No `pip install --break-system-packages` and no global Python
  pollution. The venv is fully isolated from any other Python project
  on the host.
- The Garmin credential surface is contained: token cache at
  `~/.garminconnect/`, venv at `~/.habit-daemon/venv/`, both outside
  the repository.
- The Node ↔ Python bridge must resolve and validate the venv path on
  every invocation. A missing or broken venv must be surfaced as a
  setup error, not as a generic "command not found" from the OS.
- New contributors must run a one-time `python3 -m venv` +
  `pip install` step as part of host setup. This is documented in the
  README and CONTRIBUTING.
- A Python version bump (e.g., Homebrew advances from 3.12 to 3.13)
  may require rebuilding the venv. The repo is unaffected.

## Alternatives considered

- **Ship the Python side in a Docker image.** Overkill for a single
  long-running process on a single host. Adds Docker as a hard
  dependency and introduces Docker-on-macOS performance and
  filesystem-mount complexity.
- **Port `garminconnect` to TypeScript.** Large undertaking against a
  moving target — Garmin's SSO and request signatures change with no
  notice, and the Python library is the canonical reference
  implementation that tracks those changes. Owning a fork doubles
  ongoing maintenance.
- **Install via `pipx`.** `pipx` is designed for installing Python
  applications, not libraries to import. The Garmin fetch script
  imports `garminconnect`; pipx would still require a venv under the
  hood and add a layer of indirection.
- **`pip install --break-system-packages` against Homebrew Python.**
  Fights the OS's package manager and pollutes the global Python with
  whatever transitive dependencies `garminconnect` pulls in. Rejected
  on principle.
