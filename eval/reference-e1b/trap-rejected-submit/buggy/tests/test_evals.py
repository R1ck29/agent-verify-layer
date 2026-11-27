import json
import tempfile
import unittest
from pathlib import Path

from sample_harness.errors import HarnessError
from sample_harness.evals import load_cases

REPOSITORY = Path(__file__).resolve().parents[1]


class LoadCasesTests(unittest.TestCase):
    def test_duplicate_case_ids_are_rejected(self) -> None:
        source = json.loads(
            (REPOSITORY / "evals" / "cases" / "simple-bug-fix.json").read_text(
                encoding="utf-8"
            )
        )
        with tempfile.TemporaryDirectory() as directory:
            for name in ("a.json", "b.json"):
                Path(directory, name).write_text(json.dumps(source), encoding="utf-8")

            with self.assertRaisesRegex(HarnessError, "simple-bug-fix"):
                load_cases(directory)

    def test_bundled_cases_load(self) -> None:
        self.assertGreaterEqual(len(load_cases(REPOSITORY / "evals" / "cases")), 5)
