import json
import os
import tempfile
import unittest

from improver.problems import format_problems
from improver.report import write_candidate

DELTA = {"id": "d1", "kind": "edit", "file": "CLAUDE.md", "op": "append", "old": "", "new": "x", "reason": "r", "fixes": ["t1"]}


def built(problems):
    return {"deltas": [DELTA], "notes": "n", "problems": problems, "predictions": {"t1": "pass"}}


class ReportTest(unittest.TestCase):
    def test_passing_candidate_is_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            code, report = write_candidate(d, built([]), "run-1")
            self.assertEqual(code, 0)
            self.assertTrue(os.path.exists(os.path.join(d, "improve.json")))
            self.assertEqual(report["precheck"]["passed"], True)

    def test_rejected_candidate_exit_code(self):
        with tempfile.TemporaryDirectory() as d:
            code, report = write_candidate(d, built(["too long"]), "run-2")
            self.assertEqual(code, 1)
            with open(os.path.join(d, "improve.json"), encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["precheck"]["passed"], False)

    def test_format_problems(self):
        self.assertEqual(format_problems(["a", "b"]), "a; b")


if __name__ == "__main__":
    unittest.main()
