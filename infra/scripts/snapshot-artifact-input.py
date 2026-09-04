#!/usr/bin/env python3
"""Copy an artifact bundle from ingress using no-follow descriptors."""

from __future__ import annotations

import argparse
import os
import shutil
import stat
from pathlib import Path

FILES = (
    "am2-backend-runtime.tar.gz",
    "artifact-manifest.json",
    "SHA256SUMS",
    "lockfiles/server-package-lock.json",
    "lockfiles/webadmin-package-lock.json",
)


def open_canonical_directory(path: Path) -> int:
    if not path.is_absolute():
        raise SystemExit("artifact ingress must be an absolute canonical path")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:]:
            if component in ("", ".", ".."):
                raise SystemExit("artifact ingress path contains traversal")
            next_descriptor = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def copy_regular(source_dir_fd: int, relative: str, destination: Path) -> None:
    parts = relative.split("/")
    fd = os.dup(source_dir_fd)
    try:
        for component in parts[:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        input_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            metadata = os.fstat(input_fd)
            if not stat.S_ISREG(metadata.st_mode):
                raise SystemExit(f"artifact ingress member is not a regular file: {relative}")
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with os.fdopen(input_fd, "rb", closefd=False) as source, destination.open("xb") as target:
                shutil.copyfileobj(source, target)
        finally:
            os.close(input_fd)
    finally:
        os.close(fd)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ingress", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args()

    if not args.ingress.is_absolute():
        raise SystemExit("artifact ingress must be an absolute canonical path")
    if args.ingress.is_symlink() or args.ingress.resolve(strict=True) != args.ingress:
        raise SystemExit("artifact ingress must be a canonical non-symlink path")
    if args.destination.is_symlink() or not args.destination.is_dir():
        raise SystemExit("artifact snapshot destination must be an existing regular directory")
    if any(args.destination.iterdir()):
        raise SystemExit("artifact snapshot destination must be empty")
    ingress_fd = open_canonical_directory(args.ingress)
    try:
        for relative in FILES:
            copy_regular(ingress_fd, relative, args.destination / relative)
    finally:
        os.close(ingress_fd)


if __name__ == "__main__":
    main()
