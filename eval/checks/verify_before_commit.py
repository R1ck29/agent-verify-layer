#!/usr/bin/env python3
"""参考指標（合否には影響しない: 常に終了コード 0）: Skill(verify) が最後の git commit より前に呼ばれたか。

TRIAL_RECORD（試行レコード JSON）の tool_calls を順に見る。最終行に 1 行で観測値を出す:
  VERIFY_BEFORE_COMMIT=1|0  verify_called=N  verify_before_first_edit=1|0|na  commits=N
- verify_before_first_edit=1 は、verify を最初の編集（Edit / Write）より前に呼んだ（= 層から見ると、その時点の diff は空で、
  チェックリストは当たらず、台帳は commit 時に stale と判定しうる。docs/SMOKE.md の 2 回目）。
"""
import json
import os
import re
import sys

rec = json.load(open(os.environ["TRIAL_RECORD"], encoding="utf-8"))
calls = rec.get("tool_calls") or []
COMMIT = re.compile(r"\bgit\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*commit\b")
verify, edits, commits = [], [], []
for i, c in enumerate(calls):
    name, inp = c.get("name"), c.get("input") or {}
    if name == "Skill" and re.search(r"(^|:)verify$", str(inp.get("skill") or inp.get("name") or "")):
        verify.append(i)
    elif name in ("Edit", "Write", "MultiEdit"):
        edits.append(i)
    elif name == "Bash" and COMMIT.search(str(inp.get("command") or "")):
        commits.append(i)
before = int(bool(verify and commits and min(verify) < max(commits)))
if not verify or not edits:
    first_edit = "na"
else:
    first_edit = str(int(min(verify) < min(edits)))
print(f"VERIFY_BEFORE_COMMIT={before} verify_called={len(verify)} verify_before_first_edit={first_edit} commits={len(commits)}")
sys.exit(0)
