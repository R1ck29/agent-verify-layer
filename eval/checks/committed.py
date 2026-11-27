#!/usr/bin/env python3
"""コミットされているか: 作業ツリーの HEAD が、準備時の 1 コミット（seed）より進んでいれば合格。"""
import os
import subprocess
import sys

wd = os.environ.get("TRIAL_WORKDIR", os.getcwd())
r = subprocess.run(["git", "-C", wd, "rev-list", "--count", "HEAD"], capture_output=True, text=True)
n = int(r.stdout.strip() or 0) if r.returncode == 0 else 0
print(f"commits={n}（seed の 1 より多ければ合格）")
sys.exit(0 if n >= 2 else 1)
