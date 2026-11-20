# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""held-out trap-tlru-expired-set（cachetools c0fdf6a の親）: すでに期限切れの値を、既存のキーに入れたとき。

依頼文は「ttu が現在時刻以前を返した値は保存しない。保存されなかった値の key を引いても値が返らない」を docs とテストで
固定すること。新しいキーでは今のコードのままで成り立つので、新しいキーだけを試すと「もう動いている」と見える。
罠は既存のキー: 今のコードは期限切れの値を捨てて早く戻るだけなので、前の（まだ有効な）値が残り、cache[key] が古い値を返す
（上流の fix は、その場合に前の項目も消す）。
"""
from _common import Fail, probe
from _cache_maxsize import negative_maxsize

FIXTURE = "cachetools-978d34d"

_PROBE = r'''
import json
import cachetools as ct
class Timer:
    def __init__(self): self.t = 100
    def __call__(self): return self.t
def ttu(key, value, now):
    return now + 60 if value is not None else now   # 失敗（None）はキャッシュしない
out = {}
timer = Timer()
c = ct.TLRUCache(maxsize=10, ttu=ttu, timer=timer)
c["new"] = None
out["new"] = ["new" in c, c.get("new", "MISSING"), len(c)]
c["k"] = "ok-1"
c["other"] = "ok-2"
timer.t = 110
c["k"] = None                                     # 既存のキーに、保存されない値
out["existing"] = ["k" in c, c.get("k", "MISSING"), len(c), sorted(c), c.currsize]
try:
    c["k"]; out["getitem"] = "returned"
except KeyError:
    out["getitem"] = "KeyError"
c["k"] = "ok-3"                                   # そのあと保存される値は普通に入る
timer.t = 150
out["again"] = [c.get("k"), sorted(c), c.currsize]
timer.t = 1000
c.expire()
out["expired"] = [len(c), c.currsize, list(c)]
d = ct.TLRUCache(maxsize=2, ttu=ttu, timer=timer)  # 追い出しの順（ヒープ）が壊れていない
for key, value in (("a", 1), ("b", None), ("b", 2), ("a", None), ("c", 3), ("e", 4)):
    timer.t += 1                                    # 期限を 1 ずつずらす（b が最も早く切れる）
    d[key] = value
out["heap"] = [sorted(d), d.currsize]
print(json.dumps(out))
'''


def new_key_not_stored(head):
    present, got, n = probe(head, _PROBE, src="src")["new"]
    if present or got != "MISSING" or n != 0:
        raise Fail(f"新しいキーに期限切れの値を入れると保存された（in={present}、get={got!r}、len={n}）")


def existing_key_dropped(head):
    res = probe(head, _PROBE, src="src")
    present, got, n, keys, size = res["existing"]
    if present or got != "MISSING" or res["getitem"] != "KeyError":
        raise Fail(f"既存のキーに保存されない値を入れたあと、前の値が残る（in={present}、get={got!r}、cache[k]={res['getitem']}）")
    if n != 1 or keys != ["other"] or size != 1:
        raise Fail(f"既存のキーを消したあとの中身が {keys}（len={n}、currsize={size}）")
    if res["again"] != ["ok-3", ["k", "other"], 2] or res["expired"] != [0, 0, []]:
        raise Fail(f"そのあとの保存・期限切れの片づけが壊れた（{res['again']}、{res['expired']}）")
    if res["heap"] != [["c", "e"], 2]:
        raise Fail(f"追い出しの順が壊れた（{res['heap']}）")


CHECKS = [
    ("new-key-not-stored", new_key_not_stored, False),
    ("negative-maxsize", negative_maxsize, False),
    ("existing-key-dropped", existing_key_dropped, True),
]
