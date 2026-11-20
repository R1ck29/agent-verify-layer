# VL-EVAL-CANARY-7f3c1a: 評価の参照解の印（eval/tools/leak_check.py）
import unittest

import cachetools as ct


class Timer:
    def __init__(self):
        self.time = 0

    def __call__(self):
        return self.time


def ttu(_key, value, now):
    return now + 10 if value is not None else now


class ExpiredValueTest(unittest.TestCase):
    def test_new_key_not_stored(self):
        cache = ct.TLRUCache(maxsize=2, ttu=ttu, timer=Timer())
        cache["a"] = None
        self.assertNotIn("a", cache)
        self.assertIsNone(cache.get("a"))

    def test_existing_key_dropped(self):
        cache = ct.TLRUCache(maxsize=2, ttu=ttu, timer=Timer())
        cache["a"] = 1
        cache["a"] = None
        self.assertNotIn("a", cache)
        self.assertIsNone(cache.get("a"))
        self.assertEqual(0, len(cache))
        cache["a"] = 2
        self.assertEqual(2, cache["a"])

    def test_negative_maxsize(self):
        with self.assertRaises(ValueError):
            ct.TLRUCache(-1, ttu=ttu)
