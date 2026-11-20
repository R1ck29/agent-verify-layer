# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""held-out trap-cache-grow-key（cachetools 39b31bc の親）: 既存のキーの値を大きくするときの追い出しと currsize の勘定。

依頼文が頼むのは「置き換えたあとの合計が maxsize に収まるなら、関係ないエントリを追い出さない」こと（報告された症状）。
罠は、収まらないときに追い出しの途中で更新中のキー自身が追い出された場合（FIFO の最古・LRU の最も古い利用など）。
差分（新しい大きさ − 古い大きさ）だけを確保する素直な直し方では、そのキーが消えたあとも差分のまま勘定するので、
currsize が実際の合計より小さくなり、合計が maxsize を超えたまま残る。上流の fix は、自身が追い出されたら全体の大きさで確保し直す。
"""
from _common import Fail, probe
from _cache_maxsize import negative_maxsize

FIXTURE = "cachetools-16e8889"

_SETUP = r'''
import json, random, sys
import cachetools as ct
class Timer:
    def __init__(self): self.t = 0
    def __call__(self): return self.t
def make(name, maxsize):
    if name == "RRCache":
        return ct.RRCache(maxsize, choice=random.Random(0).choice, getsizeof=len)
    if name == "TTLCache":
        return ct.TTLCache(maxsize, ttl=1000, timer=Timer(), getsizeof=len)
    if name == "TLRUCache":
        return ct.TLRUCache(maxsize, ttu=lambda k, v, t: t + 1000, timer=Timer(), getsizeof=len)
    return getattr(ct, name)(maxsize, getsizeof=len)
NAMES = ["Cache", "FIFOCache", "LRUCache", "LFUCache", "RRCache", "TTLCache", "TLRUCache"]
def total(c): return sum(len(c[k]) for k in list(c))
'''

_NO_OVEREVICT = _SETUP + r'''
out = {}
for n in NAMES:
    c = make(n, 10)
    c["a"], c["b"], c["c"] = "xxx", "xxx", "xxx"
    c["b"] = "xxxx"                       # 9 - 3 + 4 = 10 <= maxsize
    out[n] = [sorted(c), c.currsize]
print(json.dumps(out))
'''

_SELF_EVICT = _SETUP + r'''
out = {}
for n in ["FIFOCache", "LRUCache", "TTLCache"]:   # どれも "a" が最初に追い出される側
    c = make(n, 10)
    c["a"], c["b"], c["c"] = "xxx", "xxxx", "xx"
    c["a"] = "xxxxxx"                      # 9 - 3 + 6 = 12 > 10。追い出しの途中で "a" 自身が消える
    out[n] = [sorted(c), c.currsize, total(c), c["a"] if "a" in c else None]
print(json.dumps(out))
'''

_RANDOM = _SETUP + r'''
rng = random.Random(int(sys.argv[1]))
out = {}
for n in NAMES:
    c, bad = make(n, 12), None
    for step in range(1500):
        k, op = rng.randrange(8), rng.random()
        if op < 0.75:
            v = "x" * rng.randrange(0, 7)
            before = {key: len(c[key]) for key in list(c)}
            fits = sum(before.values()) - before.get(k, 0) + len(v) <= 12
            c[k] = v
            if fits and set(c) != set(before) | {k}:
                bad = "step %d: 置き換え後も収まるのに %s が追い出された" % (step, sorted(set(before) - set(c)))
        elif op < 0.9:
            c.pop(k, None)
        else:
            c.get(k)
        if bad is None and (c.currsize != total(c) or c.currsize > 12):
            bad = "step %d: currsize=%d、実際の合計=%d（maxsize 12）" % (step, c.currsize, total(c))
        if bad:
            break
    out[n] = bad
print(json.dumps(out))
'''


def no_overevict(head):
    for name, (keys, size) in probe(head, _NO_OVEREVICT, src="src").items():
        if keys != ["a", "b", "c"] or size != 10:
            raise Fail(f"{name}: 置き換え後の合計が maxsize に収まるのに追い出された（残り {keys}、currsize {size}）")


def self_eviction_accounting(head):
    for name, (keys, size, real, a) in probe(head, _SELF_EVICT, src="src").items():
        if size != real or real > 10 or a != "xxxxxx":
            raise Fail(f"{name}: 更新中のキー自身が追い出される場合に currsize={size}、実際の合計={real}（maxsize 10、残り {keys}）")


def random_invariants(head):
    for seed in ("1", "2"):
        for name, bad in probe(head, _RANDOM, seed, src="src").items():
            if bad:
                raise Fail(f"{name}（乱数の種 {seed}）: {bad}")


CHECKS = [
    ("no-overevict", no_overevict, False),           # 依頼の症状そのもの
    ("negative-maxsize", negative_maxsize, False),
    ("self-eviction-accounting", self_eviction_accounting, True),
    ("random-invariants", random_invariants, True),
]
