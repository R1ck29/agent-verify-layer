# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""held-out 対照 ctrl-moreit-running-sum（more-itertools）: running_sum(iterable, *, maxlen=None)。罠なし（整数と Fraction で見る）。"""
from _common import Fail, probe

FIXTURE = "moreit-cb75bb9"

_PROBE = r'''
import json, random
from fractions import Fraction
import more_itertools as mi
rng = random.Random(3)
bad = []
for trial in range(100):
    data = [rng.randrange(-50, 50) for _ in range(rng.randrange(0, 15))]
    if trial % 3 == 0:
        data = [Fraction(x, 7) for x in data]
    for maxlen in (None, 1, 2, 4, 20):
        want = [sum(data[:i + 1] if maxlen is None else data[max(0, i + 1 - maxlen):i + 1]) for i in range(len(data))]
        got = list(mi.running_sum(iter(data), maxlen=maxlen))
        if got != want:
            bad.append([maxlen, [str(x) for x in data], [str(x) for x in got]]); break
errs = []
for m in (0, -1):
    try:
        list(mi.running_sum([1, 2], maxlen=m)); errs.append("accepted")
    except ValueError:
        errs.append("ValueError")
print(json.dumps([bad[:1], errs, "running_sum" in mi.__all__ if hasattr(mi, "__all__") else True]))
'''


def running_sum(head):
    bad, errs, exported = probe(head, _PROBE)
    if bad:
        raise Fail(f"running_sum の結果が窓の和と違う（maxlen={bad[0][0]}、data={bad[0][1][:8]}、結果 {bad[0][2][:8]}）")
    if errs != ["ValueError", "ValueError"]:
        raise Fail(f"maxlen が 0 以下のとき ValueError にならない（{errs}）")


CHECKS = [("running-sum", running_sum, False)]
