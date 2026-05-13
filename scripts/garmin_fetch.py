#!/usr/bin/env python3
"""Garmin Connect data shim for the habit-daemon.

Three modes:
  --login                                       interactive auth setup
  --date YYYY-MM-DD --fields a,b,c              fetch sleep data
  --stub --date YYYY-MM-DD [--fields a,b,c]     canned JSON for tests

Exit codes:
  0   success (JSON on stdout, possibly {})
  1   usage error (stderr message)
  2   auth expired, invalid, or library missing (stderr message)
  3   network or API failure (stderr message)

Auth tokens are cached at ``~/.garminconnect/`` by the garminconnect
library after the first successful ``--login``.

Per ADR 0003 / phase-A divergence #5: this script is intended to be
invoked via the venv interpreter at ``~/.habit-daemon/venv/bin/python``
for the --login and --date (real-fetch) modes, because garminconnect
is installed in that venv (PEP 668 forbids global pip install on
Homebrew Python 3.12). The shebang uses system ``python3`` only so
that the --stub testing path is runnable without the venv; that path
does not import garminconnect.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


# Canned payload used by --stub mode. Tests pin these exact values.
STUB_PAYLOAD: dict[str, object] = {
    "sleep_onset_time": "2026-05-12T01:23:00",
    "total_sleep_minutes": 412,
    "rem_minutes": 78,
    "deep_sleep_minutes": 65,
    "hrv": 51.2,
}


def parse_fields(fields_arg: str | None) -> list[str]:
    """Parse a comma-separated field list. Trims whitespace and drops empties."""
    if not fields_arg:
        return []
    return [f.strip() for f in fields_arg.split(",") if f.strip()]


def project_fields(data: dict, fields: list[str]) -> dict:
    """Return a new dict containing only the requested fields that exist."""
    return {k: data[k] for k in fields if k in data}


def cmd_stub(args: argparse.Namespace) -> None:
    """Stub mode: print canned JSON and exit 0. Does NOT import garminconnect."""
    fields = parse_fields(args.fields)
    if not fields:
        fields = list(STUB_PAYLOAD.keys())
    projection = project_fields(STUB_PAYLOAD, fields)
    sys.stdout.write(json.dumps(projection))
    sys.exit(0)


# garminconnect's Garmin.login() does NOT auto-persist tokens. They live
# in-memory only unless `tokenstore=<path>` is passed, in which case the
# library writes them with client.dump(tokenstore_path). Same path must be
# passed back on subsequent loads.
TOKENSTORE_PATH = str(Path.home() / ".garminconnect")


def cmd_login() -> None:
    """Interactive login flow. Seeds the local token cache."""
    try:
        from garminconnect import Garmin  # type: ignore[import-not-found]
    except ImportError as exc:
        sys.stderr.write(f"garminconnect not installed: {exc}\n")
        sys.exit(2)

    import getpass

    email = input("Garmin email: ").strip()
    password = getpass.getpass("Garmin password: ")
    try:
        client = Garmin(email=email, password=password)
        # The garminconnect library prompts for MFA interactively on stdin
        # if the account has it enabled. Tokens are dumped to TOKENSTORE_PATH
        # on success — the path must be passed explicitly; the library does
        # not auto-persist without it.
        client.login(tokenstore=TOKENSTORE_PATH)
        sys.stderr.write(f"Login successful. Tokens cached at {TOKENSTORE_PATH}.\n")
        sys.exit(0)
    except Exception as exc:  # noqa: BLE001 - library raises bare Exception
        sys.stderr.write(f"Login failed: {exc}\n")
        sys.exit(2)


def cmd_fetch(args: argparse.Namespace) -> None:
    """Real fetch: load cached tokens, call get_sleep_data, project fields."""
    if not args.print_raw:
        fields = parse_fields(args.fields)
        if not fields:
            sys.stderr.write("--fields is required and must be non-empty\n")
            sys.exit(1)
    else:
        fields = []

    try:
        from garminconnect import Garmin  # type: ignore[import-not-found]
    except ImportError as exc:
        sys.stderr.write(f"garminconnect not installed: {exc}\n")
        sys.exit(2)

    try:
        client = Garmin()
        # Loads tokens from TOKENSTORE_PATH. Raises if the path doesn't exist
        # (no prior --login) or if the tokens are expired beyond refresh.
        client.login(tokenstore=TOKENSTORE_PATH)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"Auth failed (token may be expired): {exc}\n")
        sys.exit(2)

    try:
        raw = client.get_sleep_data(args.date)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"Network or API error: {exc}\n")
        sys.exit(3)

    if args.print_raw:
        sys.stdout.write(json.dumps(raw, indent=2, default=str))
        sys.exit(0)

    if not raw:
        sys.stdout.write("{}")
        sys.exit(0)

    projection = project_fields(raw, fields)
    sys.stdout.write(json.dumps(projection))
    sys.exit(0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="garmin_fetch.py",
        description="Garmin Connect data shim for the habit-daemon.",
    )
    parser.add_argument(
        "--login",
        action="store_true",
        help="Interactive login. Seeds ~/.garminconnect/ token cache.",
    )
    parser.add_argument(
        "--stub",
        action="store_true",
        help="Return canned JSON without importing garminconnect (test mode).",
    )
    parser.add_argument(
        "--date",
        help="Date for data fetch (YYYY-MM-DD).",
    )
    parser.add_argument(
        "--fields",
        help="Comma-separated list of fields to project from the response.",
    )
    parser.add_argument(
        "--print-raw",
        action="store_true",
        help="Print the raw Garmin response without projection (debug only). Requires --date.",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.login:
        cmd_login()
        return

    if args.stub:
        if not args.date:
            sys.stderr.write("--stub requires --date\n")
            sys.exit(1)
        cmd_stub(args)
        return

    if args.print_raw and not args.date:
        sys.stderr.write("--print-raw requires --date\n")
        sys.exit(1)

    if args.date:
        cmd_fetch(args)
        return

    parser.print_help(sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
