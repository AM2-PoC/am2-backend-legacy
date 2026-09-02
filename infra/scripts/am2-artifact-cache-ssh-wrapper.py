#!/usr/bin/env python3
"""Forced-command wrapper for the CI private-cache SSH key."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

SHA = r"[0-9a-f]{40}"
DIGEST = r"[0-9a-f]{64}"
COMMAND = re.compile(
    rf"^am2-artifact-cache-receive --stdin --destination ({SHA})/({DIGEST})$"
)
RECEIVER = Path(__file__).with_name("am2-artifact-cache-receive.py")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    args = parser.parse_args()

    command = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    match = COMMAND.fullmatch(command)
    if match is None:
        raise SystemExit("refusing SSH command outside immutable artifact ingress")

    process = subprocess.run(
        [sys.executable, str(RECEIVER), "--root", str(args.root), "--stdin", "--destination", f"{match.group(1)}/{match.group(2)}"],
        check=False,
    )
    raise SystemExit(process.returncode)


if __name__ == "__main__":
    main()
