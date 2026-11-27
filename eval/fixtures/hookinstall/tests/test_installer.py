import json
import os
import tempfile
import unittest

from hookinstall import installer


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "settings.json")

    def tearDown(self):
        self.dir.cleanup()

    def load(self):
        with open(self.path, encoding="utf-8") as fh:
            return json.load(fh)

    def test_install_adds_managed_hooks(self):
        installer.install(self.path)
        self.assertEqual(set(self.load()["hooks"]), {"SessionStart", "PostToolUse"})

    def test_install_twice_does_not_duplicate(self):
        installer.install(self.path)
        installer.install(self.path)
        self.assertEqual(len(self.load()["hooks"]["SessionStart"]), 1)

    def test_install_keeps_other_hooks_and_keys(self):
        other = {"matcher": "", "hooks": [{"type": "command", "command": "other"}]}
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump({"model": "x", "hooks": {"SessionStart": [other]}}, fh)
        installer.install(self.path)
        data = self.load()
        self.assertEqual(data["model"], "x")
        self.assertIn(other, data["hooks"]["SessionStart"])

    def test_uninstall(self):
        installer.install(self.path)
        installer.uninstall(self.path)
        self.assertEqual(self.load()["hooks"], {})


if __name__ == "__main__":
    unittest.main()
