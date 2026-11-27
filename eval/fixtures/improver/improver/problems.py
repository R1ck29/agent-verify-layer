"""検査で見つかった問題の文字列化。"""


def format_problems(problems):
    """問題の一覧を 1 つの文字列にする（"; " 区切り）。"""
    return "; ".join(problems)
