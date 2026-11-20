#!/usr/bin/env python3
"""費用見積もりの「履歴専用の記録」を作る（モデルは呼ばない）。

AHE v0.10.0 の開始前の見積もりは、履歴（--cache-dir の *.json の cost_usd の平均）がない呼び出しを、タスクの max_budget_usd（1.5）で数える。
held-out の full は 81 試行 × 1.5 = 121.5 USD となり、PREREG の上限（Claude 16・Codex 10）を超えて止まる。そこで、E1b の実測から
プロファイルごとの記録を cache-dir に置く。記録は hist-*.json（キャッシュのキー名ではないので、結果の再利用にはならない。--no-cache は維持）。
  Claude: E1b の trials.jsonl（既定 ../../eval-out/hard/full-e1b-merged）の cost_usd。v0.2 のプロファイル（claude-verify-v02）はまだ実測がないので
          「claude-verify-layer の実測 × 1.3」（PREREG-v02 の +30%）。
  Codex : E1b の記録は cost_usd が null（サブスクリプション）。PREREG-v02 の「実測 約 $0.09/試行」を固定値にし、v0.2 は × 1.3。
  --zero: dry（費用 0 の偽 CLI）用。全プロファイルを 0 円で置く（見積もりで止まらないように。実行の費用も 0 のまま）。
使い方: make-cost-history.py --out CACHE_DIR --agent claude|codex [--from-jsonl PATH] [--zero]
"""
import argparse
import json
import sys
from pathlib import Path

FACTOR = 1.3  # PREREG-v02: v0.2 の追加（ターン・トークン）+30%
CODEX_USD = 0.09
SETS = {
    "claude": {"profiles": ("claude-baseline", "claude-static-rules", "claude-verify-layer"), "v02": "claude-verify-v02", "p2_of": "claude-verify-layer"},
    "codex": {"profiles": ("codex-baseline", "codex-agents-md", "codex-verify-layer"), "v02": "codex-verify-v02", "p2_of": "codex-verify-layer"},
}
DEFAULT_JSONL = Path(__file__).resolve().parents[3] / "eval-out" / "hard" / "full-e1b-merged" / "trials.jsonl"


def source_rows(agent, path, zero):
    """([(profile_id, 元のタスク ID, cost_usd)], 根拠の説明)。"""
    s = SETS[agent]
    if zero:
        return [(p, "dry", 0.0) for p in (*s["profiles"], s["v02"])], "dry: 偽 CLI は費用 0"
    if agent == "codex":
        rows = [(p, "prereg-v02", CODEX_USD) for p in s["profiles"]]
        return rows + [(s["v02"], "prereg-v02", CODEX_USD * FACTOR)], f"PREREG-v02 の Codex 実測 約 ${CODEX_USD}/試行（E1b の記録は cost_usd が null）。v0.2 は × {FACTOR}"
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r["profile_id"] in s["profiles"] and r.get("cost_usd") is not None:
            rows.append((r["profile_id"], r.get("task_id", "?"), r["cost_usd"] + (r.get("judge_cost_usd") or 0.0)))
    missing = [p for p in s["profiles"] if not any(x[0] == p for x in rows)]
    if missing:
        raise SystemExit(f"{path} に {missing} の実測（cost_usd）がありません")
    rows += [(s["v02"], t, c * FACTOR) for p, t, c in rows if p == s["p2_of"]]
    return rows, f"{path} の実測。{s['v02']} は {s['p2_of']} の実測 × {FACTOR}（PREREG の +30%。v0.2 はまだ実測がない）"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--agent", choices=sorted(SETS), required=True)
    ap.add_argument("--from-jsonl", default=str(DEFAULT_JSONL))
    ap.add_argument("--zero", action="store_true")
    a = ap.parse_args(argv)
    rows, basis = source_rows(a.agent, a.from_jsonl, a.zero)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("hist-*.json"):
        old.unlink()
    for i, (pid, tid, cost) in enumerate(rows):
        rec = {"profile_id": pid, "task_id": f"history:{tid}", "cost_usd": cost, "judge_cost_usd": 0.0, "history_only": True, "basis": basis}
        (out / f"hist-{pid}-{i:03d}.json").write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
    print(f"== 費用見積もりの履歴: {basis}")
    for pid in dict.fromkeys(r[0] for r in rows):
        v = [r[2] for r in rows if r[0] == pid]
        print(f"   {pid}: 平均 ${sum(v) / len(v):.4f}/試行（{len(v)} 件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
