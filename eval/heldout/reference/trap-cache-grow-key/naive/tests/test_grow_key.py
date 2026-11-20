# VL-EVAL-CANARY-7f3c1a: 評価の参照解の印（eval/tools/leak_check.py）
import unittest

import cachetools as ct


class Timer:
    def __init__(self):
        self.time = 0

    def __call__(self):
        return self.time


def caches(maxsize):
    yield ct.Cache(maxsize, getsizeof=len)
    yield ct.FIFOCache(maxsize, getsizeof=len)
    yield ct.LRUCache(maxsize, getsizeof=len)
    yield ct.LFUCache(maxsize, getsizeof=len)
    yield ct.RRCache(maxsize, getsizeof=len)
    yield ct.TTLCache(maxsize, ttl=100, timer=Timer(), getsizeof=len)
    yield ct.TLRUCache(maxsize, ttu=lambda k, v, t: t + 100, timer=Timer(), getsizeof=len)


class GrowExistingKeyTest(unittest.TestCase):
    def test_grow_within_maxsize_keeps_others(self):
        for cache in caches(10):
            cache["a"], cache["b"], cache["c"] = "xxx", "xxx", "xxx"
            cache["b"] = "xxxx"
            self.assertEqual({"a", "b", "c"}, set(cache), type(cache).__name__)
            self.assertEqual(10, cache.currsize)

    def test_negative_maxsize(self):
        with self.assertRaises(ValueError):
            ct.LRUCache(-1)
        self.assertEqual(0, ct.LRUCache(0).maxsize)
