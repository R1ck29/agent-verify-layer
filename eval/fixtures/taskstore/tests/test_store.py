import json
import os
import tempfile
import unittest

from taskstore.store import save_tasks
from taskstore.summary import count_by_status


class StoreTest(unittest.TestCase):
    def test_save_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "tasks.json")
            save_tasks(path, [{"id": 1, "status": "open", "created": "2026-01-01"}])
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["tasks"][0]["id"], 1)

    def test_count_by_status(self):
        tasks = [{"status": "open"}, {"status": "done"}, {"status": "open"}]
        self.assertEqual(count_by_status(tasks), {"done": 1, "open": 2})


if __name__ == "__main__":
    unittest.main()
