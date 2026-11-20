# VL-EVAL-CANARY-7f3c1a: 評価の参照解の印（eval/tools/leak_check.py）
import unittest

import cachetools as ct


class RRChoiceContractTest(unittest.TestCase):
    def test_empty_popitem_with_custom_choice(self):
        for choice in (min, max, lambda seq: next(iter(seq))):
            cache = ct.RRCache(maxsize=2, choice=choice)
            with self.assertRaises(KeyError):
                cache.popitem()
            cache[1] = 1
            self.assertEqual((1, 1), cache.popitem())
            with self.assertRaises(KeyError):
                cache.popitem()

    def test_choice_must_be_callable(self):
        with self.assertRaises(TypeError):
            ct.RRCache(maxsize=2, choice=5)
