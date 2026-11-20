#!/usr/bin/env python3
"""held-out のタスク YAML の leak_patterns（上流 cachetools・schedule・more-itertools への取得・参照 = INVALID）の単体テスト（モデルは呼ばない）。
AHE v0.10 の leak 検査（harness_eval.cheatproof.leak_check）は、旧 eval/tools/leak_check.py にあった held-out の上流の規則を持たないので、
タスク YAML の leak_patterns で足す。PyYAML と AHE が要る（AHE の venv の python で動かす。なければ SKIP）。
  AHE_DIR=../../ahe-sound <AHE>/.venv/bin/python eval/heldout/tools/test_leak_patterns.py"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

HELD = Path(__file__).resolve().parent.parent
EVAL = HELD.parent
AHE = next((Path(c).resolve() for c in (os.environ.get("AHE_DIR"), EVAL / "../../ahe-sound", EVAL / "../../agent-harness-eval")
            if c and (Path(c) / "harness_eval" / "cheatproof.py").is_file()), None)
try:
    import yaml
except ImportError:
    yaml = None
if AHE:
    sys.path.insert(0, str(AHE))


def bash(cmd):
    return {"name": "Bash", "input": {"command": cmd, "description": "x"}}


INVALID = [
    bash("git clone https://github.com/tkem/cachetools /tmp/c"),
    bash("curl -s https://pypi.org/pypi/cachetools/json | head"),
    bash("pip install --upgrade cachetools"),
    bash("cd x && pip download more-itertools"),
    bash("pip3 install schedule"),
    bash("pip3.12 install -U more_itertools"),
    bash("python3 -m pip install -U schedule"),
    bash("wget https://raw.githubusercontent.com/dbader/schedule/master/schedule/__init__.py"),
    bash('/bin/bash -lc "git fetch https://github.com/more-itertools/more-itertools"'),
    bash("gh search code 'popitem' --repo tkem/cachetools"),
    {"name": "WebFetch", "input": {"url": "https://github.com/tkem/cachetools/commit/abc123"}},
]
CLEAN = [
    bash("python3 -m unittest discover -s tests -t ."),
    bash("PYTHONPATH=src python3 -B -m unittest tests/test_cache.py"),
    bash("git log --oneline | head"),
    bash("git diff HEAD~1"),
    bash("grep -rn cachetools src | head"),
    bash("ls src/cachetools && sed -n 1,40p src/cachetools/__init__.py"),
    bash('git commit -am "fix schedule at() for the weekday job"'),
    bash('python3 -c "import schedule; print(schedule.__file__)"'),
    bash("pip install -e ."),
    {"name": "Edit", "input": {"file_path": "README.rst", "old_string": "x", "new_string": "Install with\n\n    pip install cachetools\n"}},
]


@unittest.skipUnless(AHE and yaml, "PyYAML と AHE が要る（AHE の venv の python で動かす）")
class LeakPatterns(unittest.TestCase):
    def patterns(self, f):
        d = yaml.safe_load(f.read_text(encoding="utf-8"))
        self.assertTrue(d.get("leak_patterns"), f"{f.name}: leak_patterns がない")
        return d["leak_patterns"]

    def check(self, pats, call):
        from harness_eval.cheatproof import leak_check
        with tempfile.TemporaryDirectory() as t:
            trial = Path(t) / "trial"
            trial.mkdir()
            return leak_check([call], "", trial, patterns=pats)

    def test_every_task_has_the_patterns_and_they_compile(self):
        files = sorted((HELD / "tasks").glob("*.yaml"))
        self.assertEqual(len(files), 9)
        first = self.patterns(files[0])
        for f in files:
            self.assertEqual(self.patterns(f), first, f.name)

    def test_upstream_fetches_are_invalid(self):
        pats = self.patterns(sorted((HELD / "tasks").glob("*.yaml"))[0])
        for call in INVALID:
            r = self.check(pats, call)
            self.assertEqual(r["status"], "INVALID", f"INVALID になるはず: {call}")

    def test_normal_work_is_clean(self):
        pats = self.patterns(sorted((HELD / "tasks").glob("*.yaml"))[0])
        for call in CLEAN:
            r = self.check(pats, call)
            self.assertEqual(r["status"], "clean", f"clean のはず: {call} → {r['hits']}")


if __name__ == "__main__":
    unittest.main()
