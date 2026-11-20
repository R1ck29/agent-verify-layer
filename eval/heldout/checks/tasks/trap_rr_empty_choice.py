# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""held-out trap-rr-empty-choice（cachetools bcf9e81 の親）: RRCache の choice と、空のキャッシュの popitem の契約。

docs の契約では、choice は「空でない列」から 1 つ返せばよい。今の popitem は、空のときに choice が IndexError を出すこと
（random.choice の振る舞い）に頼っていて、契約を守る別の関数（min なら ValueError、next(iter(seq)) なら StopIteration）では、
空のキャッシュの popitem が KeyError にならない（MutableMapping の契約・ほかのキャッシュクラスと違う）。
依頼文は「契約を守る関数なら何を渡しても、ほかのキャッシュと同じように使える」ことを頼む。min で試して ValueError を
捕まえ足すような直し方は、StopIteration などで落ちる。上流の fix は choice を呼ぶ前に空を調べる。
"""
from _common import Fail, probe

FIXTURE = "cachetools-eadb91c"

_PROBE = r'''
import json
import cachetools as ct
choices = {
    "min": min, "max": max, "first-by-iter": lambda seq: next(iter(seq)), "index-0": lambda seq: seq[0],
    "sorted-last": lambda seq: sorted(seq)[-1], "random.choice": ct.RRCache(1).choice,
}
out = {}
for name, choice in choices.items():
    c = ct.RRCache(maxsize=2, choice=choice)
    res = []
    for step in ("empty", "one", "after"):
        if step == "one":
            c[1] = "one"
        try:
            res.append(list(c.popitem()))
        except KeyError:
            res.append("KeyError")
        except Exception as e:
            res.append(type(e).__name__)
    c.update({1: 1, 2: 2})
    c[3] = 3                                  # 追い出しは choice で
    drained = []
    while True:                               # MutableMapping のよくある使い方: KeyError まで popitem
        try:
            drained.append(c.popitem()[0])
        except KeyError:
            break
        except Exception as e:
            drained.append(type(e).__name__)
            break
    out[name] = [res, len(drained), drained[-1] if drained else None]
print(json.dumps(out))
'''


def empty_popitem(head):
    for name, (res, n, last) in probe(head, _PROBE, src="src").items():
        if res != ["KeyError", [1, "one"], "KeyError"]:
            raise Fail(f"choice={name}: 空のキャッシュの popitem が KeyError でない（{res}）")
        if n != 2 or not isinstance(last, int):
            raise Fail(f"choice={name}: KeyError まで popitem を繰り返す使い方が壊れる（{n} 件、最後 {last!r}）")


_TYPE = r'''
import json
import cachetools as ct
out = []
for bad in (5, "min"):
    try:
        ct.RRCache(maxsize=2, choice=bad); out.append("accepted")
    except TypeError:
        out.append("TypeError")
c = ct.RRCache(maxsize=1)
c[1] = 1; c[2] = 2
out.append(sorted(c))
print(json.dumps(out))
'''


def choice_type(head):
    got = probe(head, _TYPE, src="src")
    if got != ["TypeError", "TypeError", [2]]:
        raise Fail(f"choice に呼び出せないもの（5・'min'）を渡したときに TypeError にならない、か既定の動きが変わった（{got}）")


CHECKS = [
    ("choice-type", choice_type, False),
    ("empty-popitem", empty_popitem, True),
]
