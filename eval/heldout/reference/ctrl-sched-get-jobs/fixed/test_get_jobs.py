# VL-EVAL-CANARY-7f3c1a: 評価の参照解の印（eval/tools/leak_check.py）
import unittest

import schedule


class GetJobsTests(unittest.TestCase):
    def test_get_jobs(self):
        s = schedule.Scheduler()
        a = s.every().second.do(lambda: None).tag("db")
        b = s.every().minute.do(lambda: None)
        self.assertEqual([a, b], s.get_jobs())
        self.assertEqual([a], s.get_jobs("db"))
        s.get_jobs().clear()
        self.assertEqual(2, len(s.jobs))
