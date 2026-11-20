# VL-EVAL-CANARY-7f3c1a: 評価の参照解の印（eval/tools/leak_check.py）
import unittest

import cachetools as ct


class IterUpdateTest(unittest.TestCase):
    def caches(self):
        yield ct.TTLCache(10, ttl=100, timer=lambda: 0)
        yield ct.LRUCache(10)

    def test_update_while_iterating(self):
        for cache in self.caches():
            for k in range(5):
                cache[k] = k
            seen = []
            for k in cache:
                seen.append(k)
                cache[k] = cache[k] + 1
            self.assertEqual(list(range(5)), sorted(seen), type(cache).__name__)
            self.assertEqual({k: k + 1 for k in range(5)}, dict(cache.items()))

    def test_ttl_repr(self):
        cache = ct.TTLCache(maxsize=2, ttl=5, timer=lambda: 0)
        cache["a"] = 1
        self.assertEqual("TTLCache({'a': 1}, maxsize=2, currsize=1, ttl=5)", repr(cache))
