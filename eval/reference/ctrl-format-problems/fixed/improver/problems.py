"""検査で見つかった問題の文字列化。"""


def format_problems(problems):
    """問題の一覧を、番号付きの複数行にする。空なら「問題なし」。"""
    if not problems:
        return "問題なし"
    return "\n".join(f"{i}. {p}" for i, p in enumerate(problems, 1))
