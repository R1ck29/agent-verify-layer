# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
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


def format_size(n_bytes):
    """バイト数を、人が読みやすい文字列にする（1024 区切り、小数 1 桁）。"""
    if n_bytes < 1024:
        return f"{n_bytes} B"
    size = float(n_bytes)
    for unit in ("KB", "MB", "GB"):
        size /= 1024
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}"
