"""検査の結果を <out_dir>/improve.json に書く。"""
import json
import os

BODY_KEYS = ("old", "new", "reason")


def _write(out_dir, report):
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "improve.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)


def write_candidate(out_dir, built, run_id):
    """built = {"deltas": [提案の辞書], "notes": 文字列, "problems": [文字列], "predictions": 辞書}。
    戻り値は (終了コード, 記録した辞書)。検査を通れば 0、見送りなら 1。"""
    problems = built["problems"]
    report = {
        "run_id": run_id,
        "precheck": {"passed": not problems, "problems": problems},
        "predictions": built["predictions"],
    }
    if problems:
        report["deltas"] = [{k: v for k, v in d.items() if k not in BODY_KEYS} for d in built["deltas"]]
        _write(out_dir, report)
        return 1, report
    report["notes"] = built["notes"]
    report["deltas"] = built["deltas"]
    _write(out_dir, report)
    return 0, report
