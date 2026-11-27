"""パスの一覧を拡張子ごとに集計し、テキストにする。"""
from collections import Counter
from pathlib import PurePosixPath


def summarize(paths):
    """パス（文字列）の一覧から {"count": 件数, "by_ext": {拡張子: 件数}} を作る。"""
    by_ext = Counter(PurePosixPath(p).suffix or "(none)" for p in paths)
    return {"count": len(paths), "by_ext": dict(sorted(by_ext.items()))}


def render(summary):
    """summarize の結果を、1 行 1 拡張子のテキストにする。"""
    lines = [f"files: {summary['count']}"]
    for ext, n in summary["by_ext"].items():
        lines.append(f"  {ext}: {n}")
    return "\n".join(lines)
