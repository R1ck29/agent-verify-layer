#!/usr/bin/env python3
"""E1b の fixture が、元のリポジトリの pinned SHA の写しであることを確かめる（刈り込み・書き換えは MANIFEST に宣言したものだけ）。

使い方: e1b-provenance.py [--repos DIR]   （既定 $E1B_REPOS_DIR または $E1B_REPOS_DIR）
fixtures-e1b/<fixture>.manifest.json（fixture の外。エージェントには見えない）の各 fixture について:
  - fixture のファイルのうち、changed にも added にもないもの → base の同じパスと同じ内容
  - changed のパス → base にあり、内容が違う（刈り込み・気をそらすもの）
  - added のパス → base にない（評価用に足したもの: verify スキル、チェックリストなど）
元のリポジトリがない端末では、その fixture を飛ばす（終了コード 0、SKIP と出す）。終了コード 1 = 食い違いあり。
"""
import json
import os
import subprocess
import sys
from pathlib import Path

EVAL = Path(__file__).resolve().parent.parent
FX = EVAL / "fixtures-e1b"
repos = Path(os.environ.get("E1B_REPOS_DIR", "$E1B_REPOS_DIR"))
if "--repos" in sys.argv:
    repos = Path(sys.argv[sys.argv.index("--repos") + 1])

bad = 0
for mf in sorted(FX.glob("*.manifest.json")):
    name, m = mf.name[: -len(".manifest.json")], json.loads(mf.read_text(encoding="utf-8"))
    repo = repos / m["repo"]
    root = FX / name
    if not (repo / ".git").exists():
        print(f"  SKIP {name}: {repo} がない")
        continue
    files = sorted(str(p.relative_to(root)).replace(os.sep, "/") for p in root.rglob("*") if p.is_file())
    changed, added = set(m.get("changed", [])), set(m.get("added", []))
    errs = []
    for rel in files:
        r = subprocess.run(["git", "-C", str(repo), "show", f"{m['base']}:{rel}"], capture_output=True)
        here = (root / rel).read_bytes()
        if rel in added:
            if r.returncode == 0:
                errs.append(f"added なのに base にある: {rel}")
        elif r.returncode != 0:
            errs.append(f"base にない（added に書く）: {rel}")
        elif rel in changed:
            if r.stdout == here:
                errs.append(f"changed なのに base と同じ: {rel}")
        elif r.stdout != here:
            errs.append(f"base と違う（changed に書く）: {rel}")
    for rel in sorted((changed | added) - set(files)):
        errs.append(f"MANIFEST にあるが fixture にない: {rel}")
    if errs:
        bad = 1
        print(f"  FAIL {name}: " + "; ".join(errs[:6]) + (f" ほか {len(errs) - 6}" if len(errs) > 6 else ""))
    else:
        print(f"  ok   {name}: {m['repo']}@{m['base'][:7]} の写し（{len(files)} ファイル、changed {len(changed)}、added {len(added)}）")
sys.exit(bad)
