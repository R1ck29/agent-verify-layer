#!/usr/bin/env python3
"""E1 の集計。試行のファイル（trials.jsonl と各試行の workdir の台帳）から、RESULTS.md の数値をすべて計算する。

使い方: aggregate.py RUN_DIR [--json OUT.json]
  RUN_DIR = eval-out/full/<run>（trials.jsonl と trials/ を持つ）。標準出力に要約の JSON、--json に試行ごとの値も含む JSON。
モデルは呼ばない。判定の基準は RESULTS.md の「事前に固定した判定基準」に書いたとおり（ここで変えない）。
"""
import json
import re
import statistics as st
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

P0, P1, P2 = "claude-baseline", "claude-static-rules", "claude-verify-layer"
PROFILES = [P0, P1, P2]
CODEX_PROFILES = ["codex-baseline", "codex-agents-md", "codex-verify-layer"]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import leak_check  # noqa: E402  答えを見た形跡（INVALID）
import tamper_check  # noqa: E402  見えているテストの改ざん（合格にしない）
REPO = Path(__file__).resolve().parents[2]
# 試行の外でも読んでよいファイル: 層の hook が呼ぶ scripts/vl.js（この checkout と、VL_ALLOW に「:」区切りで足したもの。
# 過去の実行は別の checkout の vl.js を使っている）
import os  # noqa: E402
ALLOW = [str(REPO / "scripts/vl.js")] + [a for a in os.environ.get("VL_ALLOW", "").split(":") if a]
COMMIT = re.compile(r"\bgit\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*commit\b")
VERIFY = re.compile(r"(^|:)verify$")
# エージェントが評価の中身（隠しテスト・参照解）を読んだ形跡
# 参考（事前定義の外）: ファイルを書く Bash（heredoc・リダイレクト・sed -i・python の write）。Edit/Write だけを編集と数える事前定義は変えず、別枠で数える
BASH_WRITE = re.compile(r"(>>?\s*[\w./-]+\.(py|json|md)\b|sed\s+-i|\.write\(|write_text\(|\btee\b)")
PEEK = re.compile(r"(/eval/(checks|reference|tasks|profiles|fixtures)\b|hidden\.py|checks/hidden|/reference/(trap|ctrl))")


def kind(task):
    return "trap" if task.startswith("trap-") else "ctrl"


def hidden_pass(r):
    g = next(g for g in r["grader_results"] if g["label"].startswith("隠しテスト"))
    return g["status"] == "pass", g["reason"]


def classify(calls):
    """トランスクリプト上の実態: A/B/C/D（RESULTS.md の定義）と、Skill を経由しない直接実行か。"""
    def cmd(c):
        return str((c["input"] or {}).get("command") or "")
    verify = [i for i, c in enumerate(calls) if c["name"] == "Skill" and VERIFY.search(str((c["input"] or {}).get("skill") or ""))]
    commit = [i for i, c in enumerate(calls) if c["name"] == "Bash" and COMMIT.search(cmd(c))]
    edit = [i for i, c in enumerate(calls) if c["name"] in ("Edit", "Write", "MultiEdit")]
    test = [i for i, c in enumerate(calls) if c["name"] == "Bash" and "unittest" in cmd(c)]
    end = min(commit) if commit else len(calls)
    first_edit = min(edit) if edit else None
    direct = False
    if not verify:
        cls = "A"
        direct = any(i <= end for i in test)  # git commit と && でつないだ同じ呼び出しも数える
    else:
        later = [i for i in edit if min(verify) < i < end]
        if not later:
            cls = "B"
        else:
            cls = "C" if any(max(later) < i <= end for i in test) else "D"
    bw = [i for i, c in enumerate(calls) if c["name"] == "Bash" and BASH_WRITE.search(cmd(c))]
    cls_bw = cls
    if verify:
        later = [i for i in edit + bw if min(verify) < i < end]
        cls_bw = "B" if not later else ("C" if any(max(later) < i <= end for i in test) else "D")
    return {
        "class_bash_aware": cls_bw,
        "class": cls,
        "direct_run": direct,
        "verify_called": len(verify),
        "verify_before_last_commit": bool(verify and commit and min(verify) < max(commit)),
        "verify_before_first_edit": None if not verify or first_edit is None else min(verify) < first_edit,
    }


def ledger(td):
    f = td / "workdir/.git/claude-verify/ledger.jsonl"
    return [json.loads(x) for x in f.read_text().splitlines() if x.strip()] if f.exists() else []


def agent_commits(td):
    out = subprocess.run(["git", "-C", str(td / "workdir"), "rev-list", "--count", "HEAD"], capture_output=True, text=True, check=True)
    return int(out.stdout.strip()) - 1  # seed の 1 コミットを除く


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(st.median(xs), 4) if xs else None


def main():
    run = Path(sys.argv[1])
    rows = [json.loads(x) for x in (run / "trials.jsonl").read_text().splitlines()]
    global P0, P1, P2, PROFILES
    if any(r["profile_id"] in CODEX_PROFILES for r in rows):
        P0, P1, P2 = CODEX_PROFILES
        PROFILES = [P0, P1, P2]
    out = {"run_id": rows[0]["run_id"], "n_trials": len(rows)}
    T = []
    for r in rows:
        ok, reason = hidden_pass(r)
        td = run / "trials" / r["task_id"] / r["profile_id"] / str(r["trial"])
        if not td.exists() and r.get("trial_dir") and Path(r["trial_dir"]).exists():
            td = Path(r["trial_dir"])  # 結合した実行（trials.jsonl だけ）では、元の試行ディレクトリを見る
        so = td / "stdout.jsonl"
        peek = bool(PEEK.search(json.dumps(r["tool_calls"], ensure_ascii=False))) or bool(PEEK.search(so.read_text(errors="replace")))
        # 層の hook が呼ぶ scripts/vl.js（評価のリポジトリの中）は許可。ほかの試行の外の参照は INVALID
        lk = leak_check.check(td, allow=ALLOW)
        wd = td / "workdir"
        try:
            tm = tamper_check.check(wd) if (wd / ".git").exists() else {"status": "unknown", "findings": []}
        except Exception as e:  # noqa: BLE001  git が読めないときは不明（合格を取り消さない・印は残す）
            tm = {"status": "unknown", "findings": [str(e)[:120]]}
        leaked = lk["status"] == "INVALID"
        tampered = tm["status"] == "TAMPER"
        t = {"task": r["task_id"], "kind": kind(r["task_id"]), "profile": r["profile_id"], "trial": r["trial"],
             "env_valid": bool(r["valid"]), "peeked": peek, "leak": lk["hits"][:5], "leak_warnings": len(lk["warnings"]),
             "tamper": tm["findings"][:5], "valid": bool(r["valid"]) and not peek and not leaked,
             "hidden": ok and not tampered, "hidden_raw": ok, "reason": reason if not tampered else f"TAMPER: {tm['findings'][:2]} / {reason}", "turns": r["num_turns"] or 0, "cost": r["cost_usd"] or 0.0, "cost_source": r["cost_source"],
             **classify(r["tool_calls"])}
        if r["profile_id"] == P2 and r["agent"] != "codex":
            led = ledger(td)
            t["commit_rows"] = [x["result"] for x in led if x["kind"] == "commit"]
            t["run_rows"] = sum(x["kind"] == "run" for x in led)
            t["fired"] = sorted({f for x in led if x["kind"] == "run" for f in x.get("fired", [])})
            t["agent_commits"] = agent_commits(td)
        T.append(t)
    out["limits"] = ["n が小さい: タスク 8、1 セルあたり 2 試行。タスクごとの改善・後退は 0 か 1 回の違いで動く。区間・検定は付けない",
                     "判定は RESULTS.md の事前基準どおり。基準は結果を見たあとに変えない",
                     "A/B/C/D は Edit/Write だけを編集と数える事前定義。Bash での書き込みを数える classes_bash_aware は参考（正規表現の推定）",
                     "費用は client_estimate（サブスクリプションでの API 単価換算の推定）。モデルは 1 つ、fixture は小さな合成ライブラリ"]
    out["n"] = {"trials": len(T), "valid": sum(t["valid"] for t in T), "peeked": sum(t["peeked"] for t in T),
                "leak_invalid": sum(bool(t["leak"]) for t in T), "tamper": sum(bool(t["tamper"]) for t in T)}
    out["cheat_flags"] = {"run_has_leak": any(t["leak"] for t in T), "run_has_tamper": any(t["tamper"] for t in T),
                          "leaks": [{k: t[k] for k in ("task", "profile", "trial", "leak")} for t in T if t["leak"]],
                          "tampers": [{k: t[k] for k in ("task", "profile", "trial", "tamper")} for t in T if t["tamper"]]}
    out["models"] = sorted({str(r["meta"].get("model", r.get("agent"))) for r in rows})
    out["cli"] = sorted({r["cli_version"] for r in rows})
    out["cost_sources"] = sorted({t["cost_source"] for t in T})
    out["invalid"] = [{k: t[k] for k in ("task", "profile", "trial", "env_valid", "peeked")} for t in T if not t["valid"]]
    out["valid_rate"] = round(sum(t["valid"] for t in T) / len(T), 4)
    V = [t for t in T if t["valid"]]

    out["cells"] = {f"{p}|{k}": {"pass": sum(t["hidden"] for t in V if t["profile"] == p and t["kind"] == k),
                                 "n": sum(1 for t in V if t["profile"] == p and t["kind"] == k)}
                    for p in PROFILES for k in ("trap", "ctrl")}

    tasks = sorted({t["task"] for t in T})
    per = {task: {p: {"pass": sum(t["hidden"] for t in V if t["task"] == task and t["profile"] == p),
                      "n_valid": sum(1 for t in V if t["task"] == task and t["profile"] == p)} for p in PROFILES} for task in tasks}
    out["per_task"] = per

    def cmp(b):
        res = {k: {"improve": [], "regress": [], "same": [], "skipped": []} for k in ("trap", "ctrl")}
        for task in tasks:
            x, y = per[task][P2], per[task][b]
            if x["n_valid"] < 2 or y["n_valid"] < 2:
                bucket = "skipped"
            else:
                bucket = "improve" if x["pass"] > y["pass"] else "regress" if x["pass"] < y["pass"] else "same"
            res[kind(task)][bucket].append(task)
        return res
    out["P2_vs_P0"], out["P2_vs_P1"] = cmp(P0), cmp(P1)

    out["stats"] = {p: {"turns_median": med([t["turns"] for t in V if t["profile"] == p]),
                        "cost_median": med([t["cost"] for t in V if t["profile"] == p]),
                        "turns_mean": round(st.mean(t["turns"] for t in V if t["profile"] == p), 3),
                        "cost_total": round(sum(t["cost"] for t in V if t["profile"] == p), 4)} for p in PROFILES}

    def tmean(task, p, f):
        return st.mean(t[f] for t in V if t["task"] == task and t["profile"] == p)
    diffs = {}
    for p in (P1, P2):
        for f in ("turns", "cost"):
            d = [tmean(task, p, f) - tmean(task, P0, f) for task in tasks]
            diffs[f"{p}-P0|{f}"] = {"median_of_task_diffs": round(st.median(d), 4), "tasks_up": sum(v > 0 for v in d),
                                    "tasks_down": sum(v < 0 for v in d), "tasks": len(d)}
    out["diffs_vs_P0"] = diffs

    out["verify"] = {p: {"n": sum(t["profile"] == p for t in V),
                         "called": sum(1 for t in V if t["profile"] == p and t["verify_called"]),
                         "before_last_commit": sum(t["verify_before_last_commit"] for t in V if t["profile"] == p),
                         "before_first_edit": sum(bool(t["verify_before_first_edit"]) for t in V if t["profile"] == p),
                         "direct_run_without_skill": sum(t["direct_run"] for t in V if t["profile"] == p),
                         "classes": {c: sum(1 for t in V if t["profile"] == p and t["class"] == c) for c in "ABCD"},
                         "classes_bash_aware": {c: sum(1 for t in V if t["profile"] == p and t["class_bash_aware"] == c) for c in "ABCD"}} for p in PROFILES}

    p2 = [t for t in V if t["profile"] == P2]
    nrows, ncommits = sum(len(t["commit_rows"]) for t in p2), sum(t["agent_commits"] for t in p2)
    expect = {"A": "none", "B": "verified", "C": "verified", "D": "stale"}
    matrix = defaultdict(int)
    for t in p2:
        for res in t["commit_rows"]:
            matrix[f'{t["class"]}->{res}'] += 1
    mbw = defaultdict(int)
    for t in p2:
        for res in t["commit_rows"]:
            mbw[f'{t["class_bash_aware"]}->{res}'] += 1
    out["ledger"] = {"commit_rows": nrows, "agent_commits": ncommits, "caught_rate": round(nrows / ncommits, 4),
                     "matrix": dict(sorted(matrix.items())),
                     "match": sum(1 for t in p2 for res in t["commit_rows"] if res == expect[t["class"]]),
                     "false_stale_C": sum(1 for t in p2 if t["class"] == "C" for res in t["commit_rows"] if res == "stale"),
                     "matrix_bash_aware": dict(sorted(mbw.items())),
                     "match_bash_aware": sum(1 for t in p2 for res in t["commit_rows"] if res == expect[t["class_bash_aware"]]),
                     "run_rows": sum(t["run_rows"] for t in p2), "verify_calls_in_transcript": sum(t["verify_called"] for t in p2)}
    trap2 = [t for t in p2 if t["kind"] == "trap"]
    out["fired"] = {"trap_trials": len(trap2), "trials_with_fired": sum(bool(t["fired"]) for t in trap2),
                    "by_task": {task: [t["fired"] for t in trap2 if t["task"] == task] for task in sorted({t["task"] for t in trap2})}}
    out["failures"] = [{k: t[k] for k in ("task", "profile", "trial", "reason", "class", "verify_called")} for t in V if not t["hidden"]]

    c0 = out["cells"][f"{P0}|trap"]
    a, b, c = c0["pass"] / c0["n"] >= 7 / 8, out["fired"]["trials_with_fired"] == 0, out["valid_rate"] < 0.75
    r = out["P2_vs_P0"]
    useful = len(r["trap"]["improve"]) > len(r["trap"]["regress"]) and not r["ctrl"]["regress"]
    out["verdict"] = {"a_P0_trap_ceiling_ge_7_of_8": a, "b_no_fired_in_P2_traps": b, "c_valid_lt_75pct": c, "useful_by_rule": useful,
                      "verdict": "判定不能" if (a or b or c) else ("有用" if useful else "有用でない")}
    p1 = out["P2_vs_P1"]["trap"]
    out["P2_not_better_than_P1_on_traps"] = len(p1["improve"]) <= len(p1["regress"])

    if "--json" in sys.argv:
        Path(sys.argv[sys.argv.index("--json") + 1]).write_text(json.dumps({**out, "trials": T}, ensure_ascii=False, indent=1) + "\n")
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
