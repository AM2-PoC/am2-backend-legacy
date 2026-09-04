#!/usr/bin/env python3
"""Atomically publish a sibling directory only if destination does not exist."""

from __future__ import annotations

import argparse
import ctypes
import errno
import os
from pathlib import Path

AT_FDCWD = -100
RENAME_NOREPLACE = 1
LIBC = ctypes.CDLL(None, use_errno=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args()

    source = args.source.absolute()
    destination = args.destination.absolute()
    if source.is_symlink() or source.resolve(strict=True) != source or not source.is_dir():
        raise SystemExit("source must be a canonical regular staged directory")
    if source.parent != destination.parent:
        raise SystemExit("source and destination must be siblings on one filesystem")
    if not hasattr(LIBC, "renameat2"):
        raise SystemExit("kernel does not support atomic no-replace release publication")
    result = LIBC.renameat2(
        ctypes.c_int(AT_FDCWD), ctypes.c_char_p(os.fsencode(source)),
        ctypes.c_int(AT_FDCWD), ctypes.c_char_p(os.fsencode(destination)),
        ctypes.c_uint(RENAME_NOREPLACE),
    )
    if result:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise SystemExit("release destination already exists")
        raise OSError(error, os.strerror(error), destination)


if __name__ == "__main__":
    main()
