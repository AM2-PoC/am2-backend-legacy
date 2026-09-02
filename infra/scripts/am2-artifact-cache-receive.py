#!/usr/bin/env python3
"""Store one verified immutable AM2 runtime-artifact bundle in a private cache.

This is the bounded receiver contract. Host account/forced-command wiring is a
separate approved infrastructure mutation; this program has no network, shell,
or deployment behavior.
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
REQUIRED_FILES = {
    "am2-backend-runtime.tar.gz",
    "artifact-manifest.json",
    "SHA256SUMS",
    "lockfiles/server-package-lock.json",
    "lockfiles/webadmin-package-lock.json",
}
VERIFY = Path(__file__).with_name("verify-runtime-artifact.sh")
RENAME_NOREPLACE = 1
LIBC = ctypes.CDLL(None, use_errno=True)


def fail(message: str) -> None:
    raise SystemExit(message)


def parse_destination(value: str) -> tuple[str, str]:
    parts = value.split("/")
    if len(parts) != 2 or not SHA.fullmatch(parts[0]) or not DIGEST.fullmatch(parts[1]):
        fail("destination must be source-sha/archive-sha256")
    return parts[0], parts[1]


def files_at(root: Path) -> set[str]:
    result: set[str] = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            fail(f"artifact ingress contains symlink: {path}")
        if path.is_file():
            result.add(path.relative_to(root).as_posix())
    return result


def rename_no_replace(source: Path, destination: Path) -> None:
    if not hasattr(LIBC, "renameat2"):
        fail("kernel does not support atomic no-replace artifact publication")
    result = LIBC.renameat2(
        ctypes.c_int(-100), ctypes.c_char_p(os.fsencode(source)),
        ctypes.c_int(-100), ctypes.c_char_p(os.fsencode(destination)),
        ctypes.c_uint(RENAME_NOREPLACE),
    )
    if result:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            fail("immutable artifact destination already exists")
        raise OSError(error, os.strerror(error), destination)


def unpack_stdin(destination: Path) -> None:
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
        for member in archive:
            relative = PurePosixPath(member.name)
            if (member.islnk() or member.issym() or not member.isfile() or
                    relative.is_absolute() or ".." in relative.parts or relative == "."):
                fail("artifact stdin bundle contains unsafe member")
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                fail("artifact stdin bundle member cannot be read")
            assert source is not None
            with target.open("xb") as handle:
                shutil.copyfileobj(source, handle)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--source", type=Path)
    source_group.add_argument("--stdin", action="store_true")
    parser.add_argument("--destination", required=True)
    args = parser.parse_args()

    source_sha, archive_sha = parse_destination(args.destination)
    root = args.root.resolve()
    if args.stdin:
        with tempfile.TemporaryDirectory(prefix="am2-artifact-ingress-") as ingress:
            source = Path(ingress)
            unpack_stdin(source)
            store(root, source, source_sha, archive_sha)
        return

    assert args.source is not None
    if args.source.is_symlink():
        fail("source must be a regular artifact directory, not a symlink")
    store(root, args.source.resolve(), source_sha, archive_sha)


def store(root: Path, source: Path, source_sha: str, archive_sha: str) -> None:
    if not source.is_dir():
        fail("source must be a regular artifact directory")
    if files_at(source) != REQUIRED_FILES:
        fail("artifact ingress file set is not exact")

    verify = subprocess.run(
        [str(VERIFY),
         "--archive", str(source / "am2-backend-runtime.tar.gz"),
         "--manifest", str(source / "artifact-manifest.json"),
         "--checksums", str(source / "SHA256SUMS")],
        check=False,
        capture_output=True,
        text=True,
    )
    if verify.returncode:
        fail("artifact ingress verification failed: " + verify.stderr.strip())

    manifest = json.loads((source / "artifact-manifest.json").read_text(encoding="utf-8"))
    if manifest["source_sha"] != source_sha or manifest["archive_sha256"] != archive_sha:
        fail("destination identity does not match verified manifest")

    destination = root / source_sha / archive_sha
    destination.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix=f".{archive_sha}.tmp.") as temporary:
        staged = Path(temporary) / "bundle"
        shutil.copytree(source, staged, symlinks=False)
        os.chmod(staged, 0o750)
        rename_no_replace(staged, destination)
    print(destination)


if __name__ == "__main__":
    main()
