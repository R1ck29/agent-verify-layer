# VL-EVAL-CANARY-7f3c1a: 評価の参照解の印（eval/tools/leak_check.py）
from operator import itemgetter
from unittest import TestCase

import more_itertools as mi


class RunningKeyTests(TestCase):
    def test_key_window(self):
        data = [4, 3, 7, 0, 8, 1, 6, 2, 9, 5]
        self.assertEqual([4, 3, 3, 0, 0, 0, 1, 1, 2, 2], list(mi.running_min(data, maxlen=3, key=lambda x: x)))
        self.assertEqual([4, 4, 7, 7, 8, 8, 8, 6, 9, 9], list(mi.running_min(data, maxlen=3, key=lambda x: -x)))
        self.assertEqual([4, 4, 7, 7, 8, 8, 8, 8, 9, 9], list(mi.running_max(data, key=abs)))

    def test_stats_range(self):
        stats = list(mi.running_statistics([4, 3, 7, 1], maxlen=2))
        self.assertEqual([0, 1, 4, 6], [s.range for s in stats])
