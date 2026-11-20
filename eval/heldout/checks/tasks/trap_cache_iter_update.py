# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""held-out trap-cache-iter-update（cachetools e142483 の親）: 走査しながら既存のキーの値を置き換える。

依頼文の報告は TTLCache（最初の 1 件で走査が終わる）だけ。依頼は「どのキャッシュクラスでも、各キーがちょうど 1 回」。
罠は TLRUCache: 内部のヒープ（__order）を走査していて、置き換えのたびに新しい項目が押し込まれるので、同じキーが何度も
現れたり、現れなかったりする（上流の fix は両方を、キーの写しの走査にした）。走査中に新しいキーを足すと、どちらも
走査が終わらなくなる（写しなら終わる）。報告された TTLCache だけを直すと TLRUCache で落ちる。
"""
from _common import Fail, probe

FIXTURE = "cachetools-5af4208"

_SETUP = r'''
import json, sys, threading
import cachetools as ct
class Timer:
    def __init__(self): self.t = 0
    def __call__(self): return self.t
def make(name):
    if name == "TTLCache":
        return ct.TTLCache(100, ttl=1000, timer=Timer())
    if name == "TLRUCache":   # 値ごとに期限を変え、ヒープの順と挿入の順をずらす
        return ct.TLRUCache(100, ttu=lambda k, v, t: t + 1000 - 7 * (v % 13), timer=Timer())
    return getattr(ct, name)(100)
'''

_UPDATE = _SETUP + r'''
out = {}
for name in ["TTLCache", "TLRUCache", "LRUCache", "FIFOCache", "LFUCache", "RRCache", "Cache"]:
    c = make(name)
    for k in range(8):
        c[k] = k * 3
    seen = []
    for k in c:
        seen.append(k)
        c[k] = c[k] + 1
        if len(seen) > 50:
            break
    out[name] = [sorted(seen), len(seen), sorted(c.items())]
print(json.dumps(out))
'''

_INSERT = _SETUP + r'''
name = sys.argv[1]
c = make(name)
for k in range(5):
    c[k] = k
n = 0
try:
    for k in c:
        n += 1
        if n > 200:
            break
        c[1000 + n] = n          # 走査の途中で新しいキーを足す
    res = n
except RuntimeError:
    res = "RuntimeError"
print(json.dumps(res))
'''


def _update(head, names, trap_name):
    res = probe(head, _UPDATE, src="src")
    for name in names:
        seen, count, items = res[name]
        if seen != list(range(8)) or count != 8:
            raise Fail(f"{name}: 走査しながら値を置き換えると、現れたキーが {seen[:12]}（{count} 回。期待は 0..7 を 1 回ずつ）")
        if items != [[k, k * 3 + 1] for k in range(8)]:
            raise Fail(f"{name}: 走査のあとの中身が {items[:4]}...（すべてのキーが 1 回だけ更新されていない）")


def ttl_update(head):
    _update(head, ["TTLCache"], False)


def tlru_update(head):
    _update(head, ["TLRUCache"], True)


def other_caches_update(head):
    _update(head, ["LRUCache", "FIFOCache", "LFUCache", "RRCache", "Cache"], False)


def insert_terminates(head):
    for name in ("TTLCache", "TLRUCache"):
        n = probe(head, _INSERT, name, src="src", timeout=20)
        if n != "RuntimeError" and not (isinstance(n, int) and n <= 5):
            raise Fail(f"{name}: 走査の途中で新しいキーを足すと、走査が終わらない（{n} 回で打ち切り）")


_REPR = r'''
import json
import cachetools as ct
c = ct.TTLCache(maxsize=2, ttl=5, timer=lambda: 0)
c["a"] = 1
print(json.dumps([repr(c), repr(ct.TTLCache(maxsize=3, ttl=2.5))]))
'''


def ttl_repr(head):
    one, empty = probe(head, _REPR, src="src")
    if one != "TTLCache({'a': 1}, maxsize=2, currsize=1, ttl=5)" or empty != "TTLCache({}, maxsize=3, currsize=0, ttl=2.5)":
        raise Fail(f"TTLCache の repr が期待の形でない: {one!r} / {empty!r}")


CHECKS = [
    ("ttl-update", ttl_update, False),                 # 依頼の症状そのもの
    ("other-caches-update", other_caches_update, False),
    ("ttl-repr", ttl_repr, False),
    ("tlru-update", tlru_update, True),
    ("insert-terminates", insert_terminates, True),
]
