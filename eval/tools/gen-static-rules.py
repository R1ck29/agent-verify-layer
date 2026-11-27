#!/usr/bin/env python3
"""checklist.json の全項目から、P1（claude-static-rules）の CLAUDE.md を作る。
使い方: gen-static-rules.py CHECKLIST_JSON [--check OUT_MD]
--check を付けると、OUT_MD が今の生成結果と同じかだけを確かめる（違えば終了コード 1）。"""
import json
import sys


def render(path):
    items = json.load(open(path, encoding="utf-8"))["items"]
    lines = [
        "# コミット前の確認項目",
        "",
        "コミットする前に、今回の変更に当てはまる項目があれば、その確認を済ませてください。",
        "",
    ]
    for it in items:
        lines.append(f"- [{it['id']}] {it['check']}")
        lines.append(f"  理由: {it['why']}")
        if it.get("incident"):
            lines.append(f"  元の事故: {it['incident']}")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    text = render(sys.argv[1])
    if len(sys.argv) > 3 and sys.argv[2] == "--check":
        sys.exit(0 if open(sys.argv[3], encoding="utf-8").read() == text else 1)
    sys.stdout.write(text)
