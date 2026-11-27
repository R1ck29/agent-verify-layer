"""E1b 罠: Stop hook が、読めない入力（非 ASCII の locale で UTF-8 の JSON を読む）で例外を hook の外へ出す（sample-harness a100008）。"""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import hidden  # noqa: E402
from hidden import ASCII_ENV, UTF8_ENV, Fail  # noqa: E402

FIXTURE = "sh-a100004"
ITEM = "hook-input-failure-scope"

CODE = "import sys\nfrom sample_harness.claude_hook import entrypoint\nsys.exit(entrypoint())"


def _node(status="ready"):
    return {"id": "task", "description": "d", "depends_on": [], "status": status, "assigned_role": "implementer",
            "acceptance_criteria": ["c"], "evidence": [], "attempts": 0, "max_attempts": 2, "failure_reason": None}


def _project(name, incomplete=True):
    d = os.path.join(tempfile.mkdtemp(prefix="hidden-proj-"), name)
    os.makedirs(d)
    if incomplete:
        with open(os.path.join(d, "task-graph.json"), "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "objective": "o", "nodes": [_node()]}, fh)
    return d


def _hook(head, stdin, cwd, env, extra=None, timeout=30):
    e = {**env, "PYTHONPATH": head, "GRAPH_HARNESS_HOME": tempfile.mkdtemp(prefix="hidden-home-")}
    e.update(extra or {})
    try:
        r = subprocess.run([hidden.PY, "-B", "-c", CODE], input=stdin, cwd=cwd, env=e, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Fail(f"{timeout} 秒で終わらない（止まった）")
    return r.returncode, r.stderr.decode("utf-8", "replace")


def _expect(label, got, want):
    code, err = got
    if "Traceback" in err:
        raise Fail(f"{label}: 例外が hook の外へ出た: {err.strip().splitlines()[-1][:160]}")
    if code != want:
        raise Fail(f"{label}: 終了コード {code}（期待 {want}）: {err.strip()[-120:]}")


def check_trap(head):
    # 完了していないグラフのある、非 ASCII 名のプロジェクト。hook は完了チェックまで走って 2 で終わること
    proj = _project("プロジェクト")
    payload = json.dumps({"session_id": "s1", "cwd": proj}, ensure_ascii=False).encode("utf-8")
    for label, stdin in (("UTF-8 の JSON（非 ASCII のパス）", payload),
                         ("UTF-8 として不正なバイト列", b'{"session_id": "\xff\xfe", "cwd": "' + os.fsencode(proj) + b'\xe3"}')):
        _expect(f"ASCII の locale・{label}", _hook(head, stdin, proj, ASCII_ENV), 2)
    # 完了済み（グラフなし）なら 0 で終わること
    clean = _project("作業", incomplete=False)
    _expect("ASCII の locale・グラフなし", _hook(head, json.dumps({"cwd": clean}, ensure_ascii=False).encode("utf-8"), clean, ASCII_ENV), 0)


def check_stop_active(head):
    proj = _project("p")
    _expect("stop_hook_active", _hook(head, b'{"stop_hook_active": true}', proj, UTF8_ENV), 0)
    _expect("stop_hook_active が偽", _hook(head, b'{"stop_hook_active": false}', proj, UTF8_ENV), 2)


def check_tolerate_bad_body(head):
    proj = _project("p")
    for label, body in (("空の本文", b""), ("壊れた JSON", b"{oops")):
        _expect(label, _hook(head, body, proj, UTF8_ENV), 2)
    clean = _project("q", incomplete=False)
    _expect("空の本文・グラフなし", _hook(head, b"", clean, UTF8_ENV), 0)


def check_refuse(head):
    proj = _project("p", incomplete=False)
    for label, body in (("配列の本文", b"[1, 2]"), ("1 MiB を超える入力", json.dumps({"pad": "x" * 1_100_000}).encode())):
        _expect(label, _hook(head, body, proj, UTF8_ENV), 2)


def check_payload_cwd(head):
    proj = _project("p")                       # 未完了のグラフがあるのは payload の cwd 側だけ
    elsewhere = _project("elsewhere", incomplete=False)
    body = json.dumps({"cwd": proj}).encode()
    _expect("payload の cwd", _hook(head, body, elsewhere, UTF8_ENV), 2)
    _expect("環境変数が優先", _hook(head, body, elsewhere, UTF8_ENV, {"CLAUDE_PROJECT_DIR": elsewhere}), 0)


def check_validate_edges(head):
    d = tempfile.mkdtemp(prefix="hidden-g-", dir=head)
    nodes = [dict(_node(), id="a"), dict(_node("blocked"), id="b", depends_on=["a"]),
             dict(_node("blocked"), id="c", depends_on=["a", "b"])]
    path = os.path.join(d, "g.json")
    with open(path, "w") as fh:
        json.dump({"version": 1, "objective": "o", "nodes": nodes}, fh)
    r = subprocess.run([hidden.PY, "-B", "-m", "sample_harness.cli", "--graph", path, "validate"], cwd=head,
                       env={**UTF8_ENV, "PYTHONPATH": head}, capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise Fail(f"validate が失敗: {r.stderr.strip()[-120:]}")
    out = json.loads(r.stdout)
    if out.get("nodes") != 3 or out.get("edges") != 3 or out.get("valid") is not True:
        raise Fail(f"validate の出力が期待と違う: {out}")


CHECKS = [
    ("hook-survives-undecodable-input", check_trap, True),
    ("stop-hook-active", check_stop_active, False),
    ("empty-or-malformed-body", check_tolerate_bad_body, False),
    ("non-object-and-oversized", check_refuse, False),
    ("payload-cwd", check_payload_cwd, False),
    ("validate-edges", check_validate_edges, False),
]
