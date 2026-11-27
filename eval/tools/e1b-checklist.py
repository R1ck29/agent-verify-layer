#!/usr/bin/env python3
"""E1b の共通チェックリストを作り、全 fixture と P1 の CLAUDE.md に配る。
fixtures-e1b/_items/<task>.json（罠ごとの項目。fixture の外）を名前順に並べ、E1 の汎用の 2 項目（hooks-stdout、flaky-test-hiding）を足して、
fixtures-e1b/<fx>/.claude/verification/checklist.json と profiles-e1b/static-rules/CLAUDE.md を書く。
使い方: e1b-checklist.py [--check]   （--check は書かずに、今のファイルが生成結果と同じかだけを見る。違えば終了コード 1）"""
import json
import subprocess
import sys
from pathlib import Path

EVAL = Path(__file__).resolve().parent.parent
FX = EVAL / "fixtures-e1b"
items = []
for p in sorted((FX / "_items").glob("*.json")):
    items += json.loads(p.read_text(encoding="utf-8"))
e1 = json.loads((EVAL / "fixtures/snapkit/.claude/verification/checklist.json").read_text(encoding="utf-8"))["items"]
items += [it for it in e1 if it["id"] in ("hooks-stdout", "flaky-test-hiding")]
ids = [it["id"] for it in items]
assert len(ids) == len(set(ids)), f"id が重複: {ids}"
text = json.dumps({"version": 1, "items": items}, ensure_ascii=False, indent=2) + "\n"
targets = [d / ".claude/verification/checklist.json" for d in sorted(FX.iterdir()) if d.is_dir() and not d.name.startswith("_")]
check = "--check" in sys.argv
bad = [t for t in targets if not t.is_file() or t.read_text(encoding="utf-8") != text]
if check:
    sys.exit(1 if bad else 0)
for t in bad:
    t.parent.mkdir(parents=True, exist_ok=True)
    t.write_text(text, encoding="utf-8")
md = subprocess.run([sys.executable, str(EVAL / "tools/gen-static-rules.py"), str(targets[0])], capture_output=True, text=True, check=True).stdout
out = EVAL / "profiles-e1b/static-rules/CLAUDE.md"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(md, encoding="utf-8")
print(f"{len(items)} 項目 → {len(targets)} fixture と {out.relative_to(EVAL)}")
