# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""held-out trap-running-minmax-ties（more-itertools d992be0 の親）: 窓つきの running_min / running_max の「同点」の扱い。

依頼文は key 引数を足し、「各時点の結果を、その窓に組み込みの min()/max() を key 付きで当てたものと同じに」と頼む。
組み込みの min/max は同点なら先に来た要素を返す（安定）。今の窓つきの実装は、同じ値を「新しい方」で置き換える
（`not s[-1] < value` で同点も捨てる）ので、同点の要素が区別できると（key 付き・0 と 0.0 など）組み込みと違う要素を返す。
既存の比較に key を当てるだけの素直な実装は、同点のない値で試すと合うが、同点で落ちる。上流の fix は比較を <= / >= にした。
"""
from _common import Fail, probe

FIXTURE = "moreit-cb75bb9"

_PROBE = r'''
import json, random, sys
from fractions import Fraction
import more_itertools as mi
mode = sys.argv[1]
rng = random.Random(7)
out = []
def brute(f, data, maxlen, key):
    res = []
    for i in range(len(data)):
        win = data[:i + 1] if maxlen is None else data[max(0, i + 1 - maxlen):i + 1]
        res.append(f(win) if key is None else f(win, key=key))
    return res
for trial in range(0 if mode == "types" else 200):
    n = rng.randrange(1, 12)
    if mode == "distinct":
        data = rng.sample(range(100), n); key = (lambda x: -x) if trial % 2 else (lambda x: x % 1000)
    else:
        data = [(rng.randrange(3), i) for i in range(n)]; key = lambda p: p[0]
    for maxlen in (None, 1, 2, 3, 5):
        for name, f in (("running_min", min), ("running_max", max)):
            got = list(getattr(mi, name)(data, key=key, maxlen=maxlen))
            want = brute(f, data, maxlen, key)
            if got != want:
                out.append([name, maxlen, data, got, want]); break
    if out:
        break
if mode == "types":
    data = [0, 0.0, Fraction(0)]
    out = [[name, [type(x).__name__ for x in getattr(mi, name)(data, maxlen=2)],
            [type(x).__name__ for x in brute(f, data, 2, None)]] for name, f in (("running_min", min), ("running_max", max))]
    out = [o for o in out if o[1] != o[2]]
print(json.dumps(out, default=str))
'''


def key_distinct(head):
    bad = probe(head, _PROBE, "distinct")
    if bad:
        name, maxlen, data, got, want = bad[0]
        raise Fail(f"{name}(key=..., maxlen={maxlen}) が組み込みと違う（data={data}、結果 {got}、期待 {want}）")


def key_ties(head):
    bad = probe(head, _PROBE, "ties")
    if bad:
        name, maxlen, data, got, want = bad[0]
        raise Fail(f"同点のある列で {name}(key=..., maxlen={maxlen}) が組み込みの min/max と違う要素を返す（data={data}、結果 {got}、期待 {want}）")


def no_key_ties(head):
    bad = probe(head, _PROBE, "types")
    if bad:
        raise Fail(f"key なしでも同点（0, 0.0, Fraction(0)）で組み込みと違う要素: {bad}")


_STATS = r'''
import json
import more_itertools as mi
s = list(mi.running_statistics([4, 3, 7, 1], maxlen=2))
print(json.dumps([[x.range for x in s], [x.minimum for x in s], list(mi.running_min([4, 3, 7]))]))
'''


def stats_range(head):
    got = probe(head, _STATS)
    if got != [[0, 1, 4, 6], [4, 3, 3, 1], [4, 3, 3]]:
        raise Fail(f"Stats の range（maximum - minimum）が期待と違う、か既存の結果が変わった（{got}）")


CHECKS = [
    ("key-distinct", key_distinct, False),
    ("stats-range", stats_range, False),
    ("key-ties", key_ties, True),
    ("no-key-ties", no_key_ties, True),
]
