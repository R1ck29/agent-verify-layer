# VL-EVAL-CANARY-7f3c1a: 評価の参照解の印（eval/tools/leak_check.py）
import unittest

import cachetools as ct


class FreeTest(unittest.TestCase):
    def test_free(self):
        cache = ct.LRUCache(10, getsizeof=len)
        self.assertEqual(10, cache.free)
        cache["a"] = "abc"
        self.assertEqual(7, cache.free)
        with self.assertRaises(AttributeError):
            cache.free = 1
