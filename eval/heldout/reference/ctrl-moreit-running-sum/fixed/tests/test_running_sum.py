# VL-EVAL-CANARY-7f3c1a: 評価の参照解の印（eval/tools/leak_check.py）
from unittest import TestCase

import more_itertools as mi


class RunningSumTests(TestCase):
    def test_basic(self):
        self.assertEqual([4, 7, 14, 14, 22], list(mi.running_sum([4, 3, 7, 0, 8])))
        self.assertEqual([4, 7, 10, 7, 8], list(mi.running_sum([4, 3, 7, 0, 8], maxlen=2)))

    def test_bad_maxlen(self):
        with self.assertRaises(ValueError):
            list(mi.running_sum([1], maxlen=0))
