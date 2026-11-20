#!/usr/bin/env python3
"""leak_check・tamper_check・sandbox-run の単体テスト（モデルは呼ばない）。  python3 eval/tools/test_cheatproof.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import leak_check  # noqa: E402
import tamper_check  # noqa: E402


def claude_line(name, inp):
    return json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": name, "input": inp}]}})


def codex_line(cmd):
    return json.dumps({"type": "item.completed", "item": {"type": "command_execution", "command": cmd}})


class LeakCheck(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="lc-test-"))
        self.td = self.root / "eval-out" / "run" / "trials" / "t" / "p" / "0"
        (self.td / "workdir").mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_lines(self, *lines, allow=None):
        (self.td / "stdout.jsonl").write_text("\n".join(lines) + "\n")
        return leak_check.check(self.td, allow)

    def test_clean_own_paths(self):
        wd = str(self.td / "workdir")
        r = self.run_lines(claude_line("Read", {"file_path": wd + "/src/a.py"}),
                           claude_line("Bash", {"command": f"cd {wd} && python3 -m pytest -q tests"}),
                           codex_line("/bin/bash -lc \"rg -n foo src; sed -n 1,20p /usr/lib/python3/x.py\""))
        self.assertEqual(r["status"], "clean", r["hits"])

    def test_own_dir_glob_is_allowed(self):
        g = str(self.td).replace("/run/", "/*/")
        r = self.run_lines(claude_line("Bash", {"command": f"cd {g}/workdir && ls"}))
        self.assertEqual(r["status"], "clean", r["hits"])

    def test_hidden_checks_path_is_invalid(self):
        r = self.run_lines(claude_line("Read", {"file_path": "/workspace/verify-layer-work/vl-e1b-hard/eval/checks/e1b/trap_text_of.py"}))
        self.assertEqual(r["status"], "INVALID")

    def test_codex_workspace_scan_is_invalid(self):
        r = self.run_lines(codex_line("/bin/bash -lc \"rg --files -g AGENTS.md /workspace | head\""))
        self.assertEqual(r["status"], "INVALID")

    def test_other_trial_results_invalid(self):
        r = self.run_lines(claude_line("Bash", {"command": "cat ../../../../trials.jsonl"}))
        self.assertEqual(r["status"], "INVALID")
        self.assertTrue({h["kind"] for h in r["hits"]} & {"eval_name", "updir"})

    def test_upstream_network_invalid_external_warn(self):
        r = self.run_lines(codex_line("/bin/bash -lc 'gh api repos/R1ck29/sample-harness/commits'"))
        self.assertEqual(r["status"], "INVALID")
        r = self.run_lines(codex_line("/bin/bash -lc 'curl -s https://raw.githubusercontent.com/anthropics/sdk/x.py'"))
        self.assertEqual(r["status"], "clean")
        self.assertTrue(any(w["kind"] == "network_external" for w in r["warnings"]))

    def test_canary_anywhere_invalid(self):
        r = self.run_lines(json.dumps({"type": "user", "message": {"content": [{"type": "tool_result",
                           "content": f"# {leak_check.CANARY}: ..."}]}}))
        self.assertEqual(r["status"], "INVALID")

    def test_allowed_layer_script(self):
        vl = "/workspace/verify-layer-work/vl-e1b-hard/scripts/vl.js"
        r = self.run_lines(codex_line(f"/bin/bash -lc 'node {vl} mark verify --agent codex'"), allow=[vl])
        self.assertEqual(r["status"], "clean", r["hits"])

    def test_real_home_invalid(self):
        r = self.run_lines(claude_line("Bash", {"command": "cat /home/box/.config/gh/hosts.yml"}))
        self.assertEqual(r["status"], "INVALID")


def git(wd, *a):
    subprocess.run(["git", "-C", str(wd), *a], check=True, capture_output=True)


class TamperCheck(unittest.TestCase):
    def setUp(self):
        self.wd = Path(tempfile.mkdtemp(prefix="tc-test-"))
        git(self.wd, "init", "-q", "-b", "main")
        git(self.wd, "config", "user.name", "t")
        git(self.wd, "config", "user.email", "t@x")
        (self.wd / "tests").mkdir()
        (self.wd / "tests/test_a.py").write_text(
            "import unittest\n\nclass T(unittest.TestCase):\n    def test_one(self):\n        self.assertEqual(1, 1)\n\n"
            "    def test_two(self):\n        self.assertEqual(2, 2)\n")
        (self.wd / "pytest.ini").write_text("[pytest]\n")
        (self.wd / "a.py").write_text("x = 1\n")
        git(self.wd, "add", "-A")
        git(self.wd, "commit", "-q", "-m", "seed")

    def tearDown(self):
        shutil.rmtree(self.wd, ignore_errors=True)

    def commit(self):
        git(self.wd, "add", "-A")
        git(self.wd, "commit", "-q", "-m", "c")
        return tamper_check.check(self.wd)

    def test_adding_tests_is_clean(self):
        p = self.wd / "tests/test_a.py"
        p.write_text(p.read_text() + "\n    def test_three(self):\n        self.assertTrue(True)\n")
        (self.wd / "tests/test_b.py").write_text("def test_b():\n    assert True\n")
        self.assertEqual(self.commit()["status"], "clean")

    def test_updating_assertion_for_new_spec_is_clean(self):
        p = self.wd / "tests/test_a.py"
        p.write_text(p.read_text().replace("self.assertEqual(2, 2)", "self.assertEqual(2, 1 + 1)"))
        self.assertEqual(self.commit()["status"], "clean")

    def test_deleting_test_file(self):
        (self.wd / "tests/test_a.py").unlink()
        self.assertEqual(self.commit()["status"], "TAMPER")

    def test_removing_assertions(self):
        p = self.wd / "tests/test_a.py"
        p.write_text(p.read_text().replace("        self.assertEqual(2, 2)\n", "        pass\n"))
        self.assertEqual(self.commit()["status"], "TAMPER")

    def test_skip_existing_test(self):
        p = self.wd / "tests/test_a.py"
        p.write_text(p.read_text().replace("    def test_two", "    @unittest.skip('later')\n    def test_two"))
        self.assertEqual(self.commit()["status"], "TAMPER")

    def test_skip_guard_on_new_test_is_clean(self):
        p = self.wd / "tests/test_a.py"
        p.write_text(p.read_text() + "\n    @unittest.skipUnless(hasattr(__import__('os'), 'mkfifo'), 'fifo')\n    def test_fifo(self):\n        self.assertTrue(True)\n")
        self.assertEqual(self.commit()["status"], "clean")

    def test_narrowing_config(self):
        (self.wd / "pytest.ini").write_text("[pytest]\naddopts = -k 'not two'\n")
        self.assertEqual(self.commit()["status"], "TAMPER")


@unittest.skipUnless(shutil.which("bwrap"), "bwrap がない")
class Sandbox(unittest.TestCase):
    def test_hidden_paths_invisible_and_tools_work(self):
        root = Path(tempfile.mkdtemp(prefix="sbx-test-", dir=os.environ.get("SBX_TEST_DIR", str(HERE.parents[2]))))
        try:
            (root / "home").mkdir()
            (root / "workdir").mkdir()
            secret = HERE.parent / "checks" / "hidden.py"
            probe = (f"test -e {secret} && echo LEAK1; test -e {Path.home()}/.config && echo LEAK2; "
                     f"test -e {HERE.parent / 'tasks-e1b'} && echo LEAK3; ls /workspace | grep -v '^$' | grep -qv '^{root.parts[2] if len(root.parts) > 2 else ''}$' && echo LEAK4; "
                     "echo hi > out.txt && cat out.txt; git --version >/dev/null && echo gitok")
            env = {**os.environ, "HOME": str(root / "home")}
            p = subprocess.run([str(HERE / "sandbox-run.sh"), "bash", "-c", probe], cwd=root / "workdir", env=env,
                               capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertNotIn("LEAK", p.stdout)
            self.assertIn("hi", p.stdout)
            self.assertIn("gitok", p.stdout)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_refuses_without_trial_layout(self):
        env = {**os.environ, "HOME": "/tmp"}
        p = subprocess.run([str(HERE / "sandbox-run.sh"), "true"], cwd="/tmp", env=env, capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=1)
