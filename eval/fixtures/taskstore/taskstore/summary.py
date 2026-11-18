"""タスク一覧の集計。タスクは {"id", "status", "created"} を持つ辞書。"""
from collections import Counter


def count_by_status(tasks):
    """status ごとの件数を、status の名前順の辞書で返す。"""
    return dict(sorted(Counter(t["status"] for t in tasks).items()))
