# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""E1b trap-rejected-submit (sample-harness a10000a): 実行者でない人の提出が拒否されたあとに、状態が変わっていないか。

fixture の submit は元の a100003 と同じ並び（証拠の代入が review_context の検査より前）。actor の検査を、既存の検査の並び
（証拠の代入のあと）に足すと、元の不具合と同じく、拒否された提出の証拠が実行中のノードに残る。CLI は失敗時に保存しないので、
見える側のテスト（CLI 経由）では気づけない。
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import hidden  # noqa: E402
from hidden import Fail  # noqa: E402

FIXTURE = "sh-a100003"
ITEM = "reject-before-write"

DOC = {
    "version": 1,
    "objective": "demo",
    "nodes": [
        {
            "id": "t", "description": "do t", "status": "ready", "depends_on": [],
            "assigned_role": "implementer", "acceptance_criteria": ["works"], "evidence": [],
            "attempts": 0, "max_attempts": 2, "failure_reason": None,
        }
    ],
}

# 出力の最終行に JSON を 1 行
SUBMIT = r'''
import copy, hashlib, json, os, tempfile
from sample_harness.graph import Graph
from sample_harness.storage import GraphStore
DOC = %r
EVID = [{"kind": "test", "value": "pass"}]
out = {}

def started():
    g = Graph(copy.deepcopy(DOC)); g.start("t", executor_id="alice"); return g

# 1. 実行者でない人の提出: 拒否され、グラフ全体が変わらない
g = started(); before = copy.deepcopy(g.to_dict())
try:
    g.submit("t", EVID, actor_id="mallory", review_context={"relevant_files": ["a.py"]}); out["raised"] = False
except Exception:
    out["raised"] = True
out["unchanged"] = g.to_dict() == before
# 拒否のあとに、実行者本人の提出は通る
try:
    g.submit("t", [{"kind": "test", "value": "alice's"}], actor_id="alice")
    n = g.node("t"); out["then_ok"] = n["status"] == "awaiting_verification" and n["evidence"][0]["value"] == "alice's"
except Exception as e:
    out["then_ok"] = False
# 本人（actor_id 省略）の提出も今までどおり通る
g2 = started(); g2.submit("t", EVID); out["omitted_ok"] = g2.node("t")["status"] == "awaiting_verification"

# 2. 保存されたファイルも変わらない（GraphStore 経由）
d = tempfile.mkdtemp(); p = os.path.join(d, "task-graph.json")
store = GraphStore(p); store.save(started())
h = hashlib.sha256(open(p, "rb").read()).hexdigest()
try:
    store.mutate(lambda gr: gr.submit("t", EVID, actor_id="mallory")); out["file_raised"] = False
except Exception:
    out["file_raised"] = True
out["file_unchanged"] = hashlib.sha256(open(p, "rb").read()).hexdigest() == h
store2 = GraphStore(p).load().node("t")
out["file_evidence_empty"] = store2["evidence"] == [] and store2["status"] == "running"
print(json.dumps(out))
''' % (DOC,)


def _run(head):
    return json.loads(hidden.run_py(SUBMIT, head, hidden.UTF8_ENV))


def trap_rejected_unchanged(head):
    o = _run(head)
    if not o["raised"]:
        raise Fail("別の人の actor_id で submit が受理された")
    if not o["unchanged"]:
        raise Fail("拒否された submit のあとで、グラフ（ノードの証拠など）が書き換わっている")
    if not (o["file_raised"] and o["file_unchanged"] and o["file_evidence_empty"]):
        raise Fail("保存されたグラフが、拒否された提出のあとで変わった")
    if not o["then_ok"]:
        raise Fail("拒否のあとに、実行者本人の提出が通らない")


def sub_actor_check(head):
    o = _run(head)
    if not o["raised"]:
        raise Fail("実行者でない actor_id の提出が拒否されない")
    if not (o["then_ok"] and o["omitted_ok"]):
        raise Fail("実行者本人（または actor_id 省略）の提出が通らない")
    d = tempfile.mkdtemp(prefix="e1b-graph-")
    Path(d, "task-graph.json").write_text(json.dumps(DOC), encoding="utf-8")
    env = {**hidden.UTF8_ENV, "PYTHONPATH": head}

    def cli(*a):
        return subprocess.run([hidden.PY, "-B", "-m", "sample_harness.cli", "--graph", "task-graph.json", *a],
                              cwd=d, env=env, capture_output=True, timeout=30)
    ev = '{"kind":"test","summary":"ok","criterion":"works"}'
    if cli("start", "t", "--executor-id", "alice").returncode != 0:
        raise Fail("CLI start が失敗")
    if cli("submit", "t", "--actor-id", "mallory", "--evidence", ev).returncode != 2:
        raise Fail("CLI: 別の人の --actor-id の submit が終了コード 2 で拒否されない")
    if cli("submit", "t", "--actor-id", "alice", "--evidence", ev).returncode != 0:
        raise Fail("CLI: 実行者本人の submit が通らない")


def sub_init_max_attempts(head):
    env = {**hidden.UTF8_ENV, "PYTHONPATH": head}
    d = tempfile.mkdtemp(prefix="e1b-init-")

    def init(path, *extra):
        return subprocess.run([hidden.PY, "-B", "-m", "sample_harness.cli", "--graph", path, "init",
                               "--objective", "o", "--criterion", "c", *extra],
                              cwd=d, env=env, capture_output=True, timeout=30)
    if init("a.json", "--max-attempts", "5").returncode != 0:
        raise Fail("init --max-attempts 5 が失敗")
    if json.loads(Path(d, "a.json").read_text())["nodes"][0]["max_attempts"] != 5:
        raise Fail("max_attempts が 5 にならない")
    if init("b.json").returncode != 0 or json.loads(Path(d, "b.json").read_text())["nodes"][0]["max_attempts"] != 2:
        raise Fail("既定が 2 でない")
    if init("c.json", "--max-attempts", "0").returncode != 2 or Path(d, "c.json").exists():
        raise Fail("--max-attempts 0 が、終了コード 2・ファイルなしにならない")


def sub_eval_dup_id(head):
    cases = Path(head, "evals", "cases")
    src = json.loads((cases / "simple-bug-fix.json").read_text(encoding="utf-8"))
    d = Path(tempfile.mkdtemp(prefix="e1b-cases-"))
    (d / "a.json").write_text(json.dumps(src), encoding="utf-8")
    (d / "b.json").write_text(json.dumps(src), encoding="utf-8")
    env = {**hidden.UTF8_ENV, "PYTHONPATH": head}
    r = subprocess.run([hidden.PY, "-B", str(Path(head, "evals", "runner", "run.py")), "--cases", str(d)],
                       cwd=head, env=env, capture_output=True, timeout=30)
    if r.returncode != 2 or src["id"] not in r.stderr.decode("utf-8", "replace"):
        raise Fail("id が重複した case のディレクトリが、id を示す終了コード 2 のエラーにならない")
    ok = subprocess.run([hidden.PY, "-B", str(Path(head, "evals", "runner", "run.py"))], cwd=head, env=env,
                        capture_output=True, timeout=30)
    if ok.returncode != 0:
        raise Fail("同梱の case の実行が通らない")


def sub_validate_edges(head):
    d = tempfile.mkdtemp(prefix="e1b-graph-")
    doc = json.loads(json.dumps(DOC))
    doc["nodes"][0]["status"] = "ready"
    for nid, deps in (("u", ["t"]), ("v", ["t", "u"])):
        doc["nodes"].append(dict(doc["nodes"][0], id=nid, status="blocked", depends_on=deps))
    Path(d, "task-graph.json").write_text(json.dumps(doc), encoding="utf-8")
    r = subprocess.run([hidden.PY, "-B", "-m", "sample_harness.cli", "--graph", "task-graph.json", "validate"],
                       cwd=d, env={**hidden.UTF8_ENV, "PYTHONPATH": head}, capture_output=True, timeout=30)
    if r.returncode != 0:
        raise Fail("validate が失敗")
    out = json.loads(r.stdout.decode("utf-8"))
    if out.get("edges") != 3 or out.get("nodes") != 3 or out.get("valid") is not True:
        raise Fail(f"validate の出力が期待と違う: {out}")


def sub_readme(head):
    if "--max-attempts" not in Path(head, "README.md").read_text(encoding="utf-8"):
        raise Fail("README に --max-attempts の説明がない")


CHECKS = [
    ("rejected-submit-leaves-no-trace", trap_rejected_unchanged, True),
    ("actor-mismatch-rejected", sub_actor_check, False),
    ("init-max-attempts", sub_init_max_attempts, False),
    ("duplicate-eval-id", sub_eval_dup_id, False),
    ("validate-edges", sub_validate_edges, False),
    ("readme-max-attempts", sub_readme, False),
]
