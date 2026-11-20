# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""検査で見つかった問題の文字列化。"""


def format_problems(problems):
    """問題の一覧を、番号付きの複数行にする。空なら「問題なし」。"""
    if not problems:
        return "問題なし"
    return "\n".join(f"{i}. {p}" for i, p in enumerate(problems, 1))
