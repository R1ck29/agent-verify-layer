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

    def test_key_ties_like_builtin(self):
        data = [(1, 'a'), (0, 'b'), (0, 'c'), (1, 'd'), (0, 'e')]
        for maxlen in (None, 2, 3):
            for f, g in ((mi.running_min, min), (mi.running_max, max)):
                want = [g(data[:i + 1] if maxlen is None else data[max(0, i + 1 - maxlen):i + 1], key=itemgetter(0))
                        for i in range(len(data))]
                self.assertEqual(want, list(f(data, key=itemgetter(0), maxlen=maxlen)))

    def test_stats_range(self):
        stats = list(mi.running_statistics([4, 3, 7, 1], maxlen=2))
        self.assertEqual([0, 1, 4, 6], [s.range for s in stats])
