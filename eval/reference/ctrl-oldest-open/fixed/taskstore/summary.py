# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""タスク一覧の集計。タスクは {"id", "status", "created"} を持つ辞書。"""
from collections import Counter


def count_by_status(tasks):
    """status ごとの件数を、status の名前順の辞書で返す。"""
    return dict(sorted(Counter(t["status"] for t in tasks).items()))


def oldest_open(tasks):
    """status が "done" でないタスクのうち、created が最も古いもの（なければ None）。"""
    pending = [t for t in tasks if t["status"] != "done"]
    return min(pending, key=lambda t: t["created"]) if pending else None
