#!/usr/bin/env python3
"""held-out の採点の入口（checks/hidden_heldout.py）の単体テスト（モデルは呼ばない）。
  python3 eval/heldout/tools/test_grading.py

確かめること（Opus 設計レビュー #5）: 採点は全プロファイル同じく、解答のツリーから「fixture の初期コミットにないテストファイル」を取り除いた
新しいコピーで、隠しテストと元の公開テストを、ファイルのパスを明示して動かす。追加テストは結果を変えない。
fixture・参照解は丸ごとコピーして動かすだけで、中身は表示しない。"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HELD = Path(__file__).resolve().parent.parent
EVAL = HELD.parent
sys.path.insert(0, str(EVAL / "tools"))
import tamper_check  # noqa: E402

GRADER = HELD / "checks" / "hidden_heldout.py"
# 3 つの fixture の形（src 配置・ルート直下・パッケージ直下）から 1 つずつ
TASKS = ["trap-cache-iter-update", "trap-weekday-at-today", "trap-running-minmax-ties"]
POISON = ("import os, sys\n"
          "open(os.path.join(os.getcwd(), 'POISON-IMPORTED'), 'w').close()\n"
          "raise RuntimeError('追加テストが import された')\n")


def fixture_of(task):
    m = re.search(r"^fixture: \.\./fixtures/(\S+)", (HELD / "tasks" / f"{task}.yaml").read_text(), re.M)
    return m.group(1)


def git(d, *a):
    return subprocess.run(["git", "-C", str(d), *a], capture_output=True, text=True, check=True).stdout


def build(task):
    """fixture を 1 コミットにし（seed-git.sh）、参照解（fixed）を重ねて新しいコミットにした作業ツリー。"""
    d = Path(tempfile.mkdtemp(prefix="grading-test-"))
    shutil.copytree(HELD / "fixtures" / fixture_of(task), d, dirs_exist_ok=True)
    subprocess.run(["sh", str(EVAL / "profiles" / "common" / "seed-git.sh"), str(d)], check=True)
    shutil.copytree(HELD / "reference" / task / "fixed", d, dirs_exist_ok=True)
    commit(d)
    return d


def commit(d, msg="change"):
    git(d, "add", "-A")
    git(d, "commit", "-q", "--allow-empty", "-m", msg)


def grade(d, task):
    env = {**os.environ, "TRIAL_WORKDIR": str(d)}
    r = subprocess.run([sys.executable, "-B", str(GRADER), task], cwd=d, env=env, capture_output=True, text=True, timeout=600)
    return r.returncode, (r.stdout.strip().splitlines() or [""])[-1]


def public_test_files(d):
    base = git(d, "rev-list", "--max-parents=0", "HEAD").split()[-1]
    files = [p for p in git(d, "ls-tree", "-r", "--name-only", base).splitlines()
             if tamper_check.TEST_FILE.search(p) and re.search(r"(^|/)(test_[^/]+|[^/]+_test)\.py$", p)]
    return sorted(files)


class Grading(unittest.TestCase):
    def setUp(self):
        self.dirs = []

    def tearDown(self):
        for d in self.dirs:
            shutil.rmtree(d, ignore_errors=True)

    def work(self, task):
        d = build(task)
        self.dirs.append(d)
        return d

    def test_pattern_matches_tamper_check(self):
        sys.path.insert(0, str(HELD / "checks"))
        import hidden_heldout
        self.assertEqual(hidden_heldout.TEST_FILE.pattern, tamper_check.TEST_FILE.pattern)

    def test_reference_passes_and_reports_public_tests(self):
        for task in TASKS:
            d = self.work(task)
            rc, line = grade(d, task)
            self.assertEqual((rc, line[:4]), (0, "PASS"), f"{task}: {line}")
            self.assertIn("public:tests", line)  # 元の公開テストを動かした

    def test_added_test_with_same_basename_and_import_side_effect_does_not_change_result(self):
        for task in TASKS:
            d = self.work(task)
            files = public_test_files(d)
            self.assertTrue(files, task)
            base = Path(files[0]).name
            for rel in (f"zz_extra/{base}", "tests/test_vl_added_poison.py", "test_vl_added_poison.py", "conftest.py"):
                p = d / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                if not p.exists():
                    p.write_text(POISON)
            commit(d, "add tests")
            rc, line = grade(d, task)
            self.assertEqual((rc, line[:4]), (0, "PASS"), f"{task}: {line}")
            # 対照: 追加テストを取り除かずに広く discover すると、この追加は結果を変える（= このケースが効いている）
            src = "src" if (d / "src").is_dir() else "."
            dirty = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", "-s", ".", "-t", ".", "-p", "test_vl_added*.py"],
                                   cwd=d, env={**os.environ, "PYTHONPATH": src}, capture_output=True, text=True)
            self.assertNotEqual(dirty.returncode, 0, "対照: 追加テストを import すると失敗するはず")

    def test_broken_original_public_test_fails_the_solution(self):
        for task in TASKS:
            d = self.work(task)
            f = d / public_test_files(d)[0]
            f.write_text(f.read_text() + "\n\nimport unittest as _u\n\n\nclass _VlBroken(_u.TestCase):\n    def test_broken(self):\n        self.fail('公開テストが落ちる')\n")
            commit(d, "break public test")
            rc, line = grade(d, task)
            self.assertEqual(rc, 1, f"{task}: {line}")
            self.assertIn("public:tests", line)

    def test_rewritten_history_without_seed_is_a_failure(self):
        task = TASKS[0]
        d = self.work(task)
        git(d, "checkout", "-q", "--orphan", "alt")
        commit(d, "not a seed")
        rc, line = grade(d, task)
        self.assertEqual(rc, 1, line)
        self.assertIn("seed", line)


if __name__ == "__main__":
    unittest.main()
