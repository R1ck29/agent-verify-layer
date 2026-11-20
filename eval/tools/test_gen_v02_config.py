#!/usr/bin/env python3
"""gen-v02-config.py の単体テスト（モデルは呼ばない）。  python3 eval/tools/test_gen_v02_config.py"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parent / "gen-v02-config.py"


class Gen(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gen-v02-test-"))
        self.wd = self.tmp / "wd"
        self.wd.mkdir()
        self.cfg = self.tmp / "cfg"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def put(self, rel, text=""):
        p = self.wd / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def gen(self, *extra):
        return subprocess.run([sys.executable, str(TOOL), str(self.wd), str(self.cfg), *extra], capture_output=True, text=True)

    def config(self):
        return json.loads((self.cfg / "config.json").read_text())

    def test_pytest_configs_select_pytest(self):
        for rel, text in (("pytest.ini", "[pytest]\n"), ("setup.cfg", "[tool:pytest]\naddopts=-q\n"), ("tox.ini", "[pytest]\n"),
                          ("pyproject.toml", "[tool.pytest.ini_options]\nminversion='6'\n")):
            shutil.rmtree(self.wd)
            self.wd.mkdir()
            self.put(rel, text)
            r = self.gen()
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(self.config()["verifyV2"]["runner"], "pytest", rel)

    def test_node_test_script_selects_node(self):
        self.put("package.json", json.dumps({"scripts": {"test": "node --test tests/"}}))
        self.assertEqual(self.gen().returncode, 0)
        self.assertEqual(self.config()["verifyV2"]["runner"], "node")

    def test_other_runners_are_unsupported_and_unverified(self):
        self.put("package.json", json.dumps({"scripts": {"test": "jest"}}))
        self.put("tests/test_x.py", "")
        r = self.gen()
        self.assertEqual(r.returncode, 0, r.stderr)
        v = self.config()["verifyV2"]
        self.assertEqual(v["runner"], "unsupported")  # V02-DESIGN §3.2・§4.1: 強制モードのまま「未検証（対応外ランナー）」
        self.assertEqual(v["mode"], "enforce")
        self.assertTrue(json.loads((self.cfg / "generated.json").read_text())["unsupported"])

    def test_on_unsupported_error_exits_3(self):
        self.put("tests/test_x.py", "")  # unittest だけ
        self.assertEqual(self.gen("--on-unsupported", "error").returncode, 3)

    def test_config_shape_follows_design_3_2(self):
        self.put("pytest.ini", "[pytest]\n")
        self.put("tests/test_a.py", "")
        self.put("test_root.py", "")
        self.put("src/app.py", "")
        self.gen()
        c = self.config()
        v = c["verifyV2"]
        self.assertEqual(c["mode"], "observe")
        self.assertEqual((v["mode"], v["adversarial"]), ("enforce", False))
        self.assertNotIn("includePaths", v)
        self.assertEqual(v["protectedPaths"], sorted(v["protectedPaths"]))
        for want in ("tests", "pytest.ini", "test_root.py"):
            self.assertIn(want, v["protectedPaths"])
        self.assertNotIn("src", v["protectedPaths"])
        self.assertNotIn("package.json", v["protectedPaths"])
        self.assertNotIn("setup.cfg", v["protectedPaths"])

    def test_multi_purpose_files_are_not_in_protected_paths(self):
        for rel in ("package.json", "pyproject.toml", "setup.cfg", "tox.ini", "noxfile.py"):
            self.put(rel, "{}" if rel.endswith("json") else "")
        self.put("pytest.ini", "[pytest]\n")
        self.put("conftest.py")
        self.gen()
        self.assertEqual(self.config()["verifyV2"]["protectedPaths"], ["conftest.py", "pytest.ini"])  # テスト専用のパスだけ（多用途は §2.4 の項目単位の保護）

    def test_deterministic_and_logged(self):
        self.put("pytest.ini", "[pytest]\n")
        self.gen()
        a = (self.cfg / "config.json").read_text()
        self.gen()
        self.assertEqual(a, (self.cfg / "config.json").read_text())
        g = json.loads((self.cfg / "generated.json").read_text())
        self.assertEqual(g["runner"], "pytest")
        self.assertIn("pytest.ini", g["reason"])

    def test_log_path_option(self):
        self.put("pytest.ini", "[pytest]\n")
        log = self.tmp / "trial" / "v02-config.json"
        self.assertEqual(self.gen("--log", str(log)).returncode, 0)
        self.assertEqual(json.loads(log.read_text())["config"], self.config())


if __name__ == "__main__":
    unittest.main()
