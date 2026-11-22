#!/usr/bin/env python3
"""held-out の決定的な評価（PREREG-v02.md + 追補 A）の主判定を、試行のファイルだけから機械的に出す（モデルは呼ばない）。

使い方: prereg_verdict_v02.py RUN_DIR [RUN_DIR ...] [--json OUT.json] [--allow ABS_FILE]...
  RUN_DIR を複数渡すと、i 番目の実行の試行 t を「試行番号 (i, t)」として扱う（5 時間枠に収めるための分割実行。
  各分割は全プロファイル × 全タスクを含むこと。対は同じ罠・同じ試行番号の P0 と P2）。
規則（PREREG-v02.md。ここでは変えない）:
  - 無効: leak_check の INVALID、AHE の valid=false、エラーの種類が agent_error・agent_crash・usage_limit・budget_stop、
    エラー文が利用上限（AHE の USAGE_LIMIT_RE と同じ）。合格にも不合格にも数えない。
  - 改ざん（tamper_check、PREREG の定義）は不合格。上限（max_turns・timeout・タスクの予算）で止まった試行は不合格（追補 A）。
  - 合格 = 隠しテスト（HEAD）が pass かつ改ざんなし。
  - 有用: P2 の罠の合格数 > P0 の罠の合格数、かつ 罠の対で 改善 > 後退、かつ 対照の対で 後退 0。
  - 判定不能: (a) P0 の罠の合格率（有効な試行のうち）が 20〜80% の外、(b) P2 の罠で v0.2 の Stop hook が一度も発火しない、
    (c) 有効な試行が全体の 75% 未満。判定不能の条件が先に効く。
  (b) は試行の hook_calls（AHE の記録）に Stop を含む呼び出しがあるかで見る。記録がない（None）ときは "unverified" と出し、
  判定には「要確認(b)」を付ける（人が v0.2 の台帳で確かめる）。
"""
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import leak_check  # noqa: E402
import tamper_check  # noqa: E402

P0, P1, P2 = "claude-baseline", "claude-verify-layer", "claude-verify-v02"
INVALIDATING = {"agent_error", "agent_crash", "usage_limit", "budget_stop", "harness_error", "setup_error", "infra_error"}
USAGE_LIMIT_RE = re.compile(r"usage limit|hit your (?:usage|rate) limit|insufficient_quota|exceeded your current quota|"
                            r"credit balance is too low|out of credits|purchase more credits", re.IGNORECASE)
REPO = Path(__file__).resolve().parents[2]


def hidden_ok(r):
    for g in r.get("grader_results") or []:
        if str(g.get("label", "")).startswith("隠しテスト"):
            return g.get("status") == "pass"
    return False  # 隠しテストの結果がない試行は合格にしない


def invalid_reason(r):
    e = r.get("error") or {}
    if e and USAGE_LIMIT_RE.search(str(e.get("message", ""))):
        return "usage_limit"
    if r.get("valid") is False:
        return r.get("invalid_reason") or e.get("type") or "invalid"
    t = e.get("type")
    return t if t in INVALIDATING else None


def stop_fired(r):
    hc = r.get("hook_calls")
    if hc is None:
        return None
    return any("stop" in json.dumps(h, ensure_ascii=False).lower() for h in hc)


def classify(run, r, allow, checks=True):
    td = run / "trials" / r["task_id"] / r["profile_id"] / str(r["trial"])
    if not td.exists() and r.get("trial_dir"):
        td = Path(r["trial_dir"])
    if checks:
        lk = leak_check.check(td, allow)
        if lk["status"] == "INVALID":
            return "invalid", "leak"
    why = invalid_reason(r)
    if why:
        return "invalid", why
    if checks:
        wd = td / "workdir"
        try:
            tm = tamper_check.check(wd) if (wd / ".git").exists() else {"status": "unknown"}
        except Exception:  # noqa: BLE001
            tm = {"status": "unknown"}
        if tm["status"] == "TAMPER":
            return "fail", "tamper"
    return ("pass", None) if hidden_ok(r) else ("fail", None)


def verdict(outcomes, fired):
    """outcomes: {(task, profile, trial_key): "pass"|"fail"|"invalid"}。fired: P2 の罠での Stop 発火（True/False/None の list）。"""
    traps = sorted({t for t, _, _ in outcomes if t.startswith("trap")})
    ctrls = sorted({t for t, _, _ in outcomes if not t.startswith("trap")})
    keys = sorted({k for _, _, k in outcomes})
    total = len(outcomes)
    valid = sum(1 for v in outcomes.values() if v != "invalid")
    def count(p, tasks):
        vs = [outcomes[(t, p, k)] for t in tasks for k in keys if (t, p, k) in outcomes]
        return sum(v == "pass" for v in vs), sum(v != "invalid" for v in vs)
    p0_pass, p0_valid = count(P0, traps)
    p2_pass, p2_valid = count(P2, traps)
    def pairs(tasks):
        imp = reg = 0
        for t in tasks:
            for k in keys:
                a, b = outcomes.get((t, P0, k)), outcomes.get((t, P2, k))
                if a in (None, "invalid") or b in (None, "invalid"):
                    continue
                imp += a == "fail" and b == "pass"
                reg += a == "pass" and b == "fail"
        return imp, reg
    t_imp, t_reg = pairs(traps)
    c_imp, c_reg = pairs(ctrls)
    p0_rate = p0_pass / p0_valid if p0_valid else None
    reasons = []
    if p0_rate is None or not (0.20 <= p0_rate <= 0.80):
        reasons.append("(a) P0 の罠の合格率が 20〜80% の外")
    fired_known = [f for f in fired if f is not None]
    b_status = "fired" if any(fired_known) else ("unverified" if not fired_known else "never")
    if b_status == "never":
        reasons.append("(b) P2 の罠で Stop hook が一度も発火しない")
    if total == 0 or valid / total < 0.75:
        reasons.append("(c) 有効な試行が 75% 未満")
    if reasons:
        v = "INCONCLUSIVE"
    elif p2_pass > p0_pass and t_imp > t_reg and c_reg == 0:
        v = "USEFUL"
    else:
        v = "NOT USEFUL"
    if b_status == "unverified" and v != "INCONCLUSIVE":
        v += " (要確認(b))"
    return {"verdict": v, "inconclusive_reasons": reasons, "p0_trap": [p0_pass, p0_valid], "p2_trap": [p2_pass, p2_valid],
            "p0_trap_rate": p0_rate, "trap_pairs": {"improved": t_imp, "regressed": t_reg},
            "ctrl_pairs": {"improved": c_imp, "regressed": c_reg}, "valid": [valid, total], "stop_hook_p2_trap": b_status}


def main(argv):
    runs, out_json, allow = [], None, [str(REPO / "scripts/vl.js")] + [a for a in os.environ.get("VL_ALLOW", "").split(":") if a]
    it = iter(argv)
    for a in it:
        if a == "--json":
            out_json = next(it)
        elif a == "--allow":
            allow.append(next(it))
        else:
            runs.append(Path(a))
    if not runs:
        print(__doc__)
        return 2
    outcomes, fired, detail = {}, [], defaultdict(list)
    for i, run in enumerate(runs):
        for line in (run / "trials.jsonl").read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            key = (i, r["trial"])
            o, why = classify(run, r, allow)
            k = (r["task_id"], r["profile_id"], key)
            if k in outcomes:
                raise SystemExit(f"同じ試行番号が重複: {k}")
            outcomes[k] = o
            detail[f'{r["profile_id"]}|{r["task_id"]}'].append({"trial": list(key), "outcome": o, "why": why})
            if r["profile_id"] == P2 and r["task_id"].startswith("trap") and o != "invalid":
                fired.append(stop_fired(r))
    res = {"runs": [str(r) for r in runs], **verdict(outcomes, fired)}
    print(json.dumps(res, ensure_ascii=False, indent=1))
    if out_json:
        Path(out_json).write_text(json.dumps({**res, "trials": detail}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
