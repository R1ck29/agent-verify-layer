# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""E1b trap-csv-roundtrip（wikiskill a10000d）: レビューシートの CSV を、Excel で数式として実行させず、かつ書いた内容と読み戻した内容を一致させる。

依頼文は「数式として実行されないように」だけを頼み、読み戻しの一致は頼まない（review-apply がシートを読んで tasks.jsonl に
入れるのは、既存のコードと README から分かる）。元の不具合は、印を付ける・外す処理はあるが、もとから ' で始まる値
（"'=x" など）が読み戻しで変わるもの。
"""
import json
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import hidden  # noqa: E402
from hidden import Fail, run_py, UTF8_ENV  # noqa: E402

FIXTURE = "wikiskill-a10000b"
ITEM = "escape-unescape-exact"

VALUES = ["'=x", "''=x", "=x", "-16000", "'abc", "plain text", "'", "@SUM(A1)", "+1", "'+1", "'-5", "'@a",
          "=1+1\nline2", "日本語の回答", "\t=cmd", "'''=z", "'日本語"]
FORMULA_LIKE = ["=x", "-16000", "@SUM(A1)", "+1", "'=x", "''=x", "'-5", "=1+1\nline2"]

# write_review_sheet（自動採点の途中）と write_sheet（review コマンドの COLUMNS）の両方の経路を、往復と書き出しで見る。
_PROBE = r'''
import csv, io, json, sys, tempfile
from pathlib import Path
from wikiskill.scoring import write_review_sheet, write_sheet, read_review_rows, read_review_sheet
from wikiskill.review import COLUMNS
values = json.loads(sys.argv[1])
out = {"rt": [], "raw": []}
with tempfile.TemporaryDirectory() as tmp:
    for path_kind in ("review", "sheet"):
        sheet = Path(tmp) / (path_kind + ".csv")
        rows = []
        for i, v in enumerate(values):
            if path_kind == "review":
                rows.append({"task_id": "id:t%d" % i, "verdict": "OK", "comment": v, "prompt": v, "reference": v, "agent_answer": v})
            else:
                rows.append({"task_id": "id:t%d" % i, "verdict": "OK", "corrected_answer": v, "rubric_note": v, "prompt": v, "agent_answer": v})
        if path_kind == "review":
            write_review_sheet(sheet, rows)
        else:
            write_sheet(sheet, COLUMNS, rows)
        back = read_review_rows(sheet)
        raw = list(csv.DictReader(io.StringIO(sheet.read_bytes().decode("utf-8-sig"), newline="")))
        for r, b, w in zip(rows, back, raw):
            for k, v in r.items():
                if k in ("task_id", "verdict"):
                    continue
                out["rt"].append([path_kind, k, v, b.get(k)])
                out["raw"].append([path_kind, k, v, w.get(k)])
print(json.dumps(out))
'''


def _probe(head, values):
    return json.loads(run_py(_PROBE, head, UTF8_ENV, args=(json.dumps(values, ensure_ascii=False),)))


def roundtrip(head):
    res = _probe(head, VALUES)
    for kind, col, want, got in res["rt"]:
        if got != want:
            raise Fail(f"{kind} シートの {col} 列: 書いた {want!r} が読み戻すと {got!r}")


def no_formula_exposed(head):
    res = _probe(head, FORMULA_LIKE)
    for kind, col, want, cell in res["raw"]:
        if cell and cell[0] in "=+-@\t\r":
            raise Fail(f"{kind} シートの {col} 列: {want!r} が CSV 上で {cell[:12]!r} と数式の文字で始まる")


def _cli(head, *args):
    r = subprocess.run([hidden.PY, "-B", "-m", "wikiskill", *args], cwd=head, env={**UTF8_ENV, "PYTHONPATH": head},
                       capture_output=True, timeout=30)
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


def status_json(head):
    with tempfile.TemporaryDirectory() as tmp:
        ws = os.path.join(tmp, "ws")
        state = {"suite": "demo", "baseline": 0.25, "r_best": 0.5, "iteration": 2, "stage": "evolve",
                 "history": [{"iteration": 1, "outcome": "accepted", "action": "create", "target": "a-skill", "val_score": 0.5}]}
        os.makedirs(ws)
        with open(os.path.join(ws, "state.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)
        code, out, err = _cli(head, "status", ws, "--json")
        if code != 0:
            raise Fail(f"status --json の終了コードが {code}: {" ".join(err.split())[-100:]}")
        try:
            got = json.loads(out)
        except ValueError:
            raise Fail("status --json の標準出力が JSON として読めない（JSON 以外が混ざっている）")
        if got != state:
            raise Fail("status --json の内容が state.json と違う")
        code, out, _ = _cli(head, "status", ws)
        if code != 0 or "accepted" not in out:
            raise Fail("--json なしの status が壊れた")


_SETUP = r'''
import json, sys
from pathlib import Path
from wikiskill.scoring import write_sheet
from wikiskill.review import COLUMNS
root = Path(sys.argv[1]); suite = root / "suite"; suite.mkdir()
tasks = [{"id": "t1", "split": "train", "prompt": "q1"}, {"id": "t2", "split": "val", "prompt": "q2"}]
(suite / "tasks.jsonl").write_text("\n".join(json.dumps(t) for t in tasks) + "\n", encoding="utf-8")
(suite / "suite.json").write_text(json.dumps({"name": "demo", "task_description": "d", "tasks": "tasks.jsonl",
    "system_prompt": "x {skill_section}", "scorer": {"type": "exact"}, "human_review": False}), encoding="utf-8")
write_sheet(root / "sheet.csv", COLUMNS, [
    {"task_id": "id:t1", "verdict": "OK", "agent_answer": "42", "prompt": "q1"},
    {"task_id": "id:t2", "verdict": "NG", "corrected_answer": "7", "rubric_note": "note", "prompt": "q2"}])
'''


def review_apply_dry_run(head):
    with tempfile.TemporaryDirectory() as tmp:
        run_py(_SETUP, head, UTF8_ENV, args=(tmp,))
        tasks = os.path.join(tmp, "suite", "tasks.jsonl")
        before = open(tasks, "rb").read()
        code, out, err = _cli(head, "review-apply", os.path.join(tmp, "suite"), os.path.join(tmp, "sheet.csv"), "--dry-run")
        if code != 0:
            raise Fail(f"review-apply --dry-run の終了コードが {code}: {" ".join(err.split())[-100:]}")
        if open(tasks, "rb").read() != before or os.path.exists(tasks + ".bak"):
            raise Fail("--dry-run なのにタスクファイルまたは .bak が書き換わった")
        if "answer_from_ok" not in out or "answer_from_correction" not in out:
            raise Fail("--dry-run が変更件数の内訳を表示しない")
        code, out, err = _cli(head, "review-apply", os.path.join(tmp, "suite"), os.path.join(tmp, "sheet.csv"))
        rows = [json.loads(l) for l in open(tasks, encoding="utf-8") if l.strip()]
        if code != 0 or rows[0].get("answer") != "42" or rows[1].get("answer") != "7" or not os.path.exists(tasks + ".bak"):
            raise Fail("--dry-run なしの review-apply が従来どおりに動かない")


def review_apply_unknown_rows(head):
    with tempfile.TemporaryDirectory() as tmp:
        run_py(_SETUP + _EXTRA_ROWS, head, UTF8_ENV, args=(tmp,))
        code, out, err = _cli(head, "review-apply", os.path.join(tmp, "suite"), os.path.join(tmp, "sheet.csv"))
        if code != 0:
            raise Fail(f"review-apply の終了コードが {code}: {" ".join(err.split())[-100:]}")
        if not re.search(r"unknown_rows\W{0,3}\s*2\b", out):
            raise Fail(f"review-apply の内訳に unknown_rows: 2 が出ない: {" ".join(out.split())[-160:]}")


_EXTRA_ROWS = r'''
write_sheet(root / "sheet.csv", COLUMNS, [
    {"task_id": "id:t1", "verdict": "OK", "agent_answer": "42", "prompt": "q1"},
    {"task_id": "id:t8", "verdict": "OK", "agent_answer": "1", "prompt": "gone"},
    {"task_id": "id:t9", "verdict": "NG", "corrected_answer": "2", "prompt": "gone"}])
'''


def readme_documents(head):
    text = open(os.path.join(head, "README.md"), encoding="utf-8").read()
    missing = [w for w in ("--dry-run", "--json") if w not in text]
    if missing:
        raise Fail("README に " + "、".join(missing) + " の説明がない")


CHECKS = [
    ("sheet_roundtrip", roundtrip, True),
    ("no_formula_exposed", no_formula_exposed, False),
    ("status_json", status_json, False),
    ("review_apply_dry_run", review_apply_dry_run, False),
    ("review_apply_unknown_rows", review_apply_unknown_rows, False),
    ("readme", readme_documents, False),
]
