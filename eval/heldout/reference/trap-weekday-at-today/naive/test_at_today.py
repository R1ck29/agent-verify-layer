# VL-EVAL-CANARY-7f3c1a: 評価の参照解の印（eval/tools/leak_check.py）
"""Regression tests: first run of jobs with .at() on the day they are scheduled."""
import datetime
import unittest

import schedule
from schedule import ScheduleValueError


class FixedNow(object):
    def __init__(self, *args):
        self.args = args

    def __enter__(self):
        args = self.args

        class MockDate(datetime.datetime):
            @classmethod
            def now(cls):
                return cls(*args)
        self.original = datetime.datetime
        datetime.datetime = MockDate

    def __exit__(self, *exc):
        datetime.datetime = self.original


class AtTodayTests(unittest.TestCase):
    def next_run(self, job):
        return job.do(lambda: None).next_run

    def test_weekday_later_today(self):
        # 2020-11-25 is a wednesday
        with FixedNow(2020, 11, 25, 22, 38, 5):
            run = self.next_run(schedule.Scheduler().every().wednesday.at('22:38:10'))
            self.assertEqual(datetime.datetime(2020, 11, 25, 22, 38, 10), run)

    def test_error_message_lists_formats(self):
        with self.assertRaises(ScheduleValueError) as ctx:
            schedule.every().day.at('25:00')
        self.assertIn('HH:MM:SS', str(ctx.exception))
