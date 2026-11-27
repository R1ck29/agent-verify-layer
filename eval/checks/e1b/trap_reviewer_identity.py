"""E1b trap-reviewer-identity (sample-harness a100003): 実行者と同じ人が、表記を少し変えるだけで自分の作業を確認できてしまわないか。"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import hidden
from hidden import Fail  # noqa: E402

FIXTURE = "sh-a100002"
ITEM = "caller-string-gate-variants"

CRIT = "works"
DOC = {
    "version": 1,
    "objective": "demo",
    "nodes": [
        {
            "id": "t", "description": "do t", "status": "ready", "depends_on": [],
            "assigned_role": "implementer", "acceptance_criteria": [CRIT], "evidence": [],
            "attempts": 0, "max_attempts": 2, "failure_reason": None,
        }
    ],
}
EVID = '{"kind":"test","summary":"ok","criterion":"works"}'


def cli(head, cwd, *args, timeout=30):
    env = {**hidden.UTF8_ENV, "PYTHONPATH": head}
    try:
        return subprocess.run([hidden.PY, "-B", "-m", "sample_harness.cli", *args], cwd=cwd, env=env,
                              capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Fail("samplectl が終わらない（止まった）")


def _graph_dir():
    d = tempfile.mkdtemp(prefix="e1b-graph-")
    Path(d, "task-graph.json").write_text(json.dumps(DOC), encoding="utf-8")
    return d


API = r'''
import json
from sample_harness.graph import Graph
def attempt(rid, executor="agent-1"):
    g = Graph(%r)
    g.start("t", executor_id=executor)
    g.submit("t", [{"kind": "test", "value": "pass"}], actor_id=executor)
    try:
        g.verify("t", "PASS", reviewer_id=rid, checked_criteria=["works"],
                 review_evidence=[{"kind": "test", "summary": "reran"}])
    except Exception:
        return "rejected"
    return "accepted"
out = {r: attempt(r) for r in ["agent-1", "agent-1 ", "Agent-1", " AGENT-1\t", "agent-2"]}
# 元の事故の形: 実行者の側の ID に末尾の空白・大文字（start の --executor-id に手で入れた値）
out.update({"exec:" + e: attempt("agent-1", executor=e) for e in ["agent-1 ", "Agent-1"]})
out["exec:agent-1 /agent-2"] = attempt("agent-2", executor="agent-1 ")
print(json.dumps(out))
''' % (DOC,)


def trap_identity(head):
    res = json.loads(hidden.run_py(API, head, hidden.UTF8_ENV))
    if res["agent-2"] != "accepted" or res["exec:agent-1 /agent-2"] != "accepted":
        raise Fail("別の人のレビューまで拒否している")
    leaked = [r for r in ("agent-1", "agent-1 ", "Agent-1", " AGENT-1\t") if res[r] != "rejected"]
    if leaked:
        raise Fail(f"実行者 agent-1 と同じ人が、表記違い {leaked!r} でレビューを通せた")
    leaked = [e for e in ("agent-1 ", "Agent-1") if res["exec:" + e] != "rejected"]
    if leaked:
        raise Fail(f"実行者 {leaked!r} と同じ人が 'agent-1' でレビューを通せた")
    # CLI でも同じ（利用者の症状: 1 人で start・submit・PASS して完了になる）
    d = _graph_dir()
    for a in (["start", "t", "--executor-id", "agent-1 "],
              ["submit", "t", "--actor-id", "agent-1 ", "--evidence", EVID]):
        if cli(head, d, "--graph", "task-graph.json", *a).returncode != 0:
            raise Fail(f"CLI の {a[0]} が失敗")
    v = ["verify", "t", "--pass", "--criterion", CRIT, "--evidence", EVID, "--reviewer-id"]
    if cli(head, d, "--graph", "task-graph.json", *v, "agent-1").returncode == 0:
        raise Fail("CLI: 実行者 'agent-1 ' の作業に 'agent-1' のレビューで PASS が記録された")
    if cli(head, d, "--graph", "task-graph.json", "completion-check").returncode == 0:
        raise Fail("CLI: 1 人で全工程を通して完了になった")
    if cli(head, d, "--graph", "task-graph.json", *v, "agent-2").returncode != 0:
        raise Fail("CLI: 別の人のレビューが通らない")


def sub_independence(head):
    res = json.loads(hidden.run_py(API, head, hidden.UTF8_ENV))
    if res["agent-1"] != "rejected":
        raise Fail("実行者と同じ ID のレビューが通った")
    if res["agent-2"] != "accepted":
        raise Fail("別の人のレビューが通らない")


def sub_status_node(head):
    doc = json.loads(json.dumps(DOC))
    second = dict(doc["nodes"][0], id="u", status="blocked", depends_on=["t"])
    doc["nodes"].append(second)
    d = tempfile.mkdtemp(prefix="e1b-graph-")
    Path(d, "task-graph.json").write_text(json.dumps(doc), encoding="utf-8")
    r = cli(head, d, "--graph", "task-graph.json", "status", "--node", "u")
    if r.returncode != 0:
        raise Fail("status --node u が失敗")
    out = json.loads(r.stdout.decode("utf-8"))
    ids = [n["id"] for n in out.get("nodes", [])]
    if ids != ["u"]:
        raise Fail(f"nodes が指定したノードだけでない: {ids}")
    both = json.loads(cli(head, d, "--graph", "task-graph.json", "status").stdout.decode("utf-8"))
    if len(both["nodes"]) != 2:
        raise Fail("--node なしの status が全ノードを出さない")
    if cli(head, d, "--graph", "task-graph.json", "status", "--node", "nope").returncode != 2:
        raise Fail("存在しないノードで終了コード 2 にならない")


def sub_size_message(head):
    d = tempfile.mkdtemp(prefix="e1b-graph-")
    size = 4 * 1024 * 1024 + 1234
    Path(d, "big.json").write_bytes(b" " * size)
    r = cli(head, d, "--graph", "big.json", "validate")
    if r.returncode == 0:
        raise Fail("4 MiB を超える graph が受理された")
    if str(size) not in r.stderr.decode("utf-8", "replace"):
        raise Fail(f"エラーに実際のバイト数 {size} がない: {r.stderr.decode('utf-8', 'replace')[-120:].replace(chr(10), ' ')}")


def sub_ready_count(head):
    doc = json.loads(json.dumps(DOC))
    doc["nodes"].append(dict(doc["nodes"][0], id="u"))
    doc["nodes"].append(dict(doc["nodes"][0], id="w", status="blocked", depends_on=["t"]))
    d = tempfile.mkdtemp(prefix="e1b-graph-")
    Path(d, "task-graph.json").write_text(json.dumps(doc), encoding="utf-8")
    r = cli(head, d, "--graph", "task-graph.json", "ready")
    out = json.loads(r.stdout.decode("utf-8")) if r.returncode == 0 else {}
    if sorted(out.get("ready") or []) != ["t", "u"] or out.get("count") != 2:
        raise Fail(f"ready の出力が期待と違う（一覧はそのまま、count=2）: {out}")


def sub_readme(head):
    text = Path(head, "README.md").read_text(encoding="utf-8")
    if not re.search(r"status\s+--node", text):
        raise Fail("README に status --node の説明がない")


CHECKS = [
    ("reviewer-same-actor-variants", trap_identity, True),
    ("reviewer-must-differ", sub_independence, False),
    ("status-node", sub_status_node, False),
    ("oversize-message", sub_size_message, False),
    ("ready-count", sub_ready_count, False),
    ("readme-status-node", sub_readme, False),
]
