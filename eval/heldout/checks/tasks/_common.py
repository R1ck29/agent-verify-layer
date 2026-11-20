# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""held-out の隠しテストの共通部分: HEAD の取り出し先でプローブ（短い Python）を別プロセスで動かし、JSON を受け取る。"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "checks"))
import hidden  # noqa: E402
from hidden import Fail  # noqa: E402,F401


def probe(head, code, *args, src="", timeout=60):
    """head（の src/ 以下）を import のルートにして code を動かし、標準出力の最終行を JSON として返す。"""
    root = os.path.join(head, src) if src else head
    env = {**hidden.UTF8_ENV, "PYTHONPATH": root}
    try:
        r = subprocess.run([hidden.PY, "-B", "-c", code, *args], cwd=head, env=env, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Fail(f"{timeout} 秒で終わらない（止まった・無限ループ）")
    out = r.stdout.decode("utf-8", "replace").strip()
    if r.returncode != 0:
        err = r.stderr.decode("utf-8", "replace").strip().splitlines() or ["(stderr なし)"]
        raise Fail(f"実行に失敗: {err[-1][:200]}")
    try:
        return json.loads(out.splitlines()[-1])
    except (IndexError, ValueError):
        raise Fail(f"結果が JSON でない: {out[-120:]!r}")
