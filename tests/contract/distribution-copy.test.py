#!/usr/bin/env python3
"""App Distribution must describe pipeline-managed storage truthfully."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = (ROOT / "WebAdmin/settings.php").read_text()
EN = (ROOT / "WebAdmin/lang/en.php").read_text()
ID = (ROOT / "WebAdmin/lang/id.php").read_text()


class DistributionCopyContract(unittest.TestCase):
    def test_read_only_pipeline_storage_is_not_rendered_as_an_error(self):
        self.assertNotIn("<?php if (!$shelf['exists'] || !$shelf['writable']): ?>", SETTINGS,
                         "a deliberately read-only pipeline shelf is shown as broken storage")
        self.assertIn("<?php if (!$shelf['exists']): ?>", SETTINGS,
                      "a genuinely missing shelf is no longer reported")
        self.assertNotRegex(
            SETTINGS,
            r"<span><\?=\s*!\$shelf\['exists'\].*set\.folder_readonly",
            "the panel tells the operator to contact support for the intended permission model",
        )

    def test_copy_says_read_only_storage_is_expected(self):
        for locale, text in (("en", EN), ("id", ID)):
            match = re.search(r"'set\.publish_via_release'\s*=>\s*'([^']+)'", text)
            self.assertIsNotNone(match, f"{locale} has no distribution ownership copy")
            assert match is not None
            message = match.group(1).lower()
            self.assertTrue("read-only" in message or "hanya-baca" in message,
                            f"{locale} does not explain that pipeline-managed storage is intentionally read-only")


if __name__ == "__main__":
    unittest.main()
