# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""cachetools の罠に共通の sub: maxsize が負なら ValueError、0 はこれまでどおり。"""
from _common import Fail, probe

_MAXSIZE = r'''
import json
import cachetools as ct
res = {}
makers = {
    "Cache": lambda m: ct.Cache(m), "LRUCache": lambda m: ct.LRUCache(m), "LFUCache": lambda m: ct.LFUCache(m),
    "FIFOCache": lambda m: ct.FIFOCache(m), "RRCache": lambda m: ct.RRCache(m),
    "TTLCache": lambda m: ct.TTLCache(m, ttl=1), "TLRUCache": lambda m: ct.TLRUCache(m, ttu=lambda k, v, t: t + 1),
}
for name, mk in makers.items():
    try:
        mk(-1); neg = "accepted"
    except ValueError:
        neg = "ValueError"
    except Exception as e:
        neg = type(e).__name__
    zero = mk(0)
    try:
        zero["k"] = 1; z = "stored"
    except ValueError:
        z = "ValueError"
    res[name] = [neg, z, zero.maxsize]
print(json.dumps(res))
'''


def negative_maxsize(head):
    for name, (neg, zero_set, zero_max) in probe(head, _MAXSIZE, src="src").items():
        if neg != "ValueError":
            raise Fail(f"{name}(maxsize=-1) が ValueError にならない（{neg}）")
        if zero_max != 0 or zero_set != "ValueError":
            raise Fail(f"{name}(maxsize=0) の動きが変わった（maxsize={zero_max}、値の追加={zero_set}）")
