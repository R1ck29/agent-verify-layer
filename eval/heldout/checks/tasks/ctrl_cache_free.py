# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""held-out 対照 ctrl-cache-free（cachetools）: 読み取り専用の Cache.free（= maxsize - currsize）。罠なし。"""
from _common import Fail, probe

FIXTURE = "cachetools-16e8889"

_PROBE = r'''
import json
import cachetools as ct
class Timer:
    def __init__(self): self.t = 0
    def __call__(self): return self.t
out = []
c = ct.LRUCache(10, getsizeof=len)
out.append(c.free)
c["a"] = "abc"; c["b"] = "xy"
out.append(c.free)
del c["a"]
out.append(c.free)
out.append(ct.Cache(3).free)
t = Timer()
tc = ct.TTLCache(5, ttl=10, timer=t)
tc[1] = 1; tc[2] = 2
out.append(tc.free)
t.t = 100
out.append(tc.free)                 # 期限切れの項目は数えない
try:
    c.free = 1; out.append("writable")
except AttributeError:
    out.append("read-only")
print(json.dumps(out))
'''


def free(head):
    got = probe(head, _PROBE, src="src")
    if got != [10, 5, 8, 3, 3, 5, "read-only"]:
        raise Fail(f"Cache.free が期待と違う: {got}（期待 [10, 5, 8, 3, 3, 5, 'read-only']）")


CHECKS = [("free", free, False)]
