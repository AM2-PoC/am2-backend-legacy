#!/usr/bin/env python3
"""Strict RED/GREEN behavioral tests for the Admin update publisher."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra/scripts/publish-admin-update.sh"
SIGNER = "a" * 64


def artifact(base: Path, *, code: int, body: bytes = b"apk bytes", declared_sha: str | None = None) -> Path:
    root = base / f"artifact-{code}"
    root.mkdir()
    apk = root / "am2-admin-production.apk"
    apk.write_bytes(body)
    digest = declared_sha or hashlib.sha256(body).hexdigest()
    (root / "admin_version.json").write_text(json.dumps({
        "package": "com.am2.admin",
        "version_code": code,
        "version_name": f"1.1.0+{code}",
        "update_url": "https://webadmin.am2-poc.com/update/admin.apk",
        "sha256": digest,
        "signer_sha256": SIGNER,
        "source_commit": "8" * 40,
        "rollout": 100,
        "changelog": {"id": "uji", "en": "test"},
    }))
    return root


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", str(SCRIPT), *args], text=True, capture_output=True)


class AdminPublisherTest(unittest.TestCase):
    def test_publishes_one_coherent_pair_and_verifies_it(self):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            source = artifact(base, code=74)
            channel = base / "channel"
            result = run("--artifact", str(source), "--update-dir", str(channel))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((channel / "admin.apk").read_bytes(), b"apk bytes")
            self.assertEqual(json.loads((channel / "admin_version.json").read_text())["version_code"], 74)
            verified = run("--verify-only", "--update-dir", str(channel))
            self.assertEqual(verified.returncode, 0, verified.stderr)

    def test_refuses_a_manifest_that_does_not_describe_the_apk(self):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            source = artifact(base, code=74, declared_sha="b" * 64)
            result = run("--artifact", str(source), "--update-dir", str(base / "channel"))
            self.assertNotEqual(result.returncode, 0)

    def test_refuses_sideways_or_backward_publication(self):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            channel = base / "channel"
            first = run("--artifact", str(artifact(base, code=74)), "--update-dir", str(channel))
            self.assertEqual(first.returncode, 0, first.stderr)
            older = run("--artifact", str(artifact(base, code=73)), "--update-dir", str(channel))
            self.assertNotEqual(older.returncode, 0)
            self.assertEqual(json.loads((channel / "admin_version.json").read_text())["version_code"], 74)

    def test_failed_post_publish_readback_restores_the_previous_pair(self):
        if os.geteuid() == 0:
            self.skipTest("permission fixture requires a non-root publisher")
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            channel = base / "channel"
            first = run("--artifact", str(artifact(base, code=74, body=b"old")), "--update-dir", str(channel))
            self.assertEqual(first.returncode, 0, first.stderr)
            before_apk = (channel / "admin.apk").read_bytes()
            before_manifest = (channel / "admin_version.json").read_bytes()
            # `nobody` exists but cannot traverse a 0700 TemporaryDirectory.
            failed = run("--artifact", str(artifact(base, code=75, body=b"new")),
                         "--update-dir", str(channel), "--reader", "nobody")
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual((channel / "admin.apk").read_bytes(), before_apk)
            self.assertEqual((channel / "admin_version.json").read_bytes(), before_manifest)


if __name__ == "__main__":
    unittest.main()
