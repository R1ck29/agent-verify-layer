"""E1b 罠: ブロック中のノードの next_action が、もう動かない（置き換え済みの）依存先を待ち先に挙げる（sample-harness a100009）。

fixture の `_next_action` は元のリポジトリの fix 前のまま（`!= "verified"` の手書きの比較）。依頼は、同じ情報を構造化した欄
`waiting_on` を status の各ノードに足すこと。隣の比較を写すと、superseded の依存先を待ち先に挙げる（元の不具合と同じ形）。
`next_action` の文字列は fix 前の不具合を含むが、依頼の範囲外なので判定しない。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import hidden  # noqa: E402
from hidden import BASE_ENV, Fail, run_py

FIXTURE = "sh-a100001"
ITEM = "status-set-single-source"

# samplectl は作業ディレクトリの外の graph を受け付けないので、head の下に graph を置く
PRELUDE = r'''
import json, os, subprocess, sys, tempfile

def node(node_id, status, deps=()):
    n = {"id": node_id, "description": "do " + node_id, "status": status, "depends_on": list(deps),
         "assigned_role": "implementer", "acceptance_criteria": ["c"], "evidence": [], "attempts": 0,
         "max_attempts": 2, "failure_reason": None}
    if status == "verified":
        ev = {"criterion": "c", "kind": "test", "summary": "pass"}
        n.update({"evidence": [ev], "attempts": 1, "executor_id": node_id + "-x", "reviewer_id": node_id + "-r",
                  "verification": {"result": "pass", "reviewer_id": node_id + "-r", "checked_criteria": ["c"],
                                   "evidence": [dict(ev, kind="independent_test")], "reason": None,
                                   "faulty_node": None, "recommendation": None, "failed_criteria": [],
                                   "affected_downstream_nodes": [], "reviewed_at": "2026-01-01T00:00:00+00:00"}})
    if status == "running":
        n.update({"attempts": 1, "executor_id": node_id + "-x"})
    if status == "superseded":
        n.update({"superseded_reason": "approach abandoned", "superseded_at": "2026-01-01T00:00:00+00:00"})
    return n

def doc(*nodes):
    return {"version": 1, "objective": "o", "nodes": list(nodes)}

def cli(path, *args):
    return subprocess.run([sys.executable, "-m", "sample_harness.cli", "--graph", path, *args],
                          capture_output=True, text=True)

def write(d):
    fd, path = tempfile.mkstemp(suffix=".json", dir=os.getcwd())
    os.close(fd)
    with open(path, "w") as fh:
        json.dump(d, fh)
    return path
'''


def _run(body, head):
    return json.loads(run_py(PRELUDE + body, head, BASE_ENV, timeout=60))


WAIT_CASE = r'''
def actions(nodes):
    p = write(doc(*nodes))
    out = {}
    r = cli(p, "status")
    cli_actions = {n["id"]: n.get("waiting_on") for n in json.loads(r.stdout)["nodes"]} if r.returncode == 0 else None
    from sample_harness.graph import Graph
    api = {n["id"]: n.get("waiting_on") for n in Graph.from_dict(doc(*nodes)).status_summary()["nodes"]}
    return {"cli": cli_actions, "api": api}
res = {
  "mixed": actions([node("old-plan", "superseded"), node("built-lib", "verified"), node("run-tests", "ready"),
                    node("report", "blocked", ["old-plan", "built-lib", "run-tests"])]),
  "two": actions([node("old-plan", "superseded"), node("run-tests", "ready"), node("lint-pass", "running"),
                  node("report", "blocked", ["old-plan", "run-tests", "lint-pass"])]),
  "plain": actions([node("built-lib", "verified"), node("run-tests", "ready"),
                    node("report", "blocked", ["built-lib", "run-tests"])]),
}
print(json.dumps(res))
'''


def _wait_results(head):
    return _run(WAIT_CASE, head)


def check_trap(head):
    res = _wait_results(head)
    for case, pending, settled in (("mixed", {"run-tests"}, {"old-plan", "built-lib"}),
                                   ("two", {"run-tests", "lint-pass"}, {"old-plan"})):
        for via in ("api", "cli"):
            actions = res[case][via]
            if actions is None:
                raise Fail("samplectl status が失敗した")
            got = actions.get("report")
            if not isinstance(got, list):
                raise Fail(f"{via}: blocked のノードの waiting_on が一覧でない: {got!r}")
            stale = sorted(settled & set(got))
            if stale:
                raise Fail(f"{via}: もう待つ必要のない依存先 {stale} を waiting_on に挙げている: {got!r}")
            if not pending <= set(got):
                raise Fail(f"{via}: 待つべき依存先 {sorted(pending)} が waiting_on に出ない: {got!r}")


def check_wait_basic(head):
    res = _wait_results(head)["plain"]
    for via in ("api", "cli"):
        if res[via] is None:
            raise Fail("samplectl status が失敗した")
        got = res[via]
        if got.get("report") != ["run-tests"]:
            raise Fail(f"{via}: blocked のノードの waiting_on が、未完了の依存先だけの一覧でない: {got.get('report')!r}")
        if got.get("run-tests") != [] or got.get("built-lib") != []:
            raise Fail(f"{via}: blocked でないノードの waiting_on が空の一覧でない: {got.get('run-tests')!r}")


def check_ready_count(head):
    res = _run(r'''
p = write(doc(node("a1", "ready"), node("a2", "ready"), node("done", "verified"),
              node("b1", "blocked", ["done"]), node("c1", "blocked", ["a1"])))
r = cli(p, "ready")
print(json.dumps({"rc": r.returncode, "out": r.stdout}))
''', head)
    if res["rc"] != 0:
        raise Fail("samplectl ready が失敗した")
    out = json.loads(res["out"])
    ready = out.get("ready")
    if sorted(ready or []) != ["a1", "a2", "b1"]:
        raise Fail(f"ready の一覧が変わった: {ready}")
    if out.get("count") != 3:
        raise Fail(f"ready の count が 3 でない: {out.get('count')!r}")


def check_ready_role(head):
    res = _run(r'''
def role(n, r):
    n["assigned_role"] = r
    return n
p = write(doc(role(node("a1", "ready"), "implementer"), role(node("r1", "ready"), "reviewer"),
              role(node("r2", "ready"), "reviewer"), role(node("x", "blocked", ["a1"]), "reviewer")))
out = {}
for key, args in (("rev", ["--role", "reviewer"]), ("none", ["--role", "nobody"]), ("all", [])):
    r = cli(p, "ready", *args)
    out[key] = [r.returncode, r.stdout]
print(json.dumps(out))
''', head)
    for key, want in (("rev", ["r1", "r2"]), ("none", []), ("all", ["a1", "r1", "r2"])):
        rc, stdout = res[key]
        if rc != 0:
            raise Fail(f"samplectl ready（{key}）が失敗した")
        out = json.loads(stdout)
        if sorted(out.get("ready") or []) != want or out.get("count") != len(want):
            raise Fail(f"ready --role の結果が違う（{key}）: {out}")


def check_status_node(head):
    res = _run(r'''
p = write(doc(node("a1", "ready"), node("a2", "ready"), node("c1", "blocked", ["a1"])))
one = cli(p, "status", "--node", "c1")
bad = cli(p, "status", "--node", "nope")
whole = cli(p, "status")
print(json.dumps({"one": [one.returncode, one.stdout], "bad": bad.returncode, "whole": [whole.returncode, whole.stdout]}))
''', head)
    if res["one"][0] != 0:
        raise Fail("status --node が失敗した")
    ids = [n["id"] for n in json.loads(res["one"][1])["nodes"]]
    if ids != ["c1"]:
        raise Fail(f"status --node c1 の nodes が c1 だけでない: {ids}")
    if res["bad"] == 0:
        raise Fail("存在しないノードを --node に渡しても終了コードが 0")
    whole = json.loads(res["whole"][1])
    if res["whole"][0] != 0 or [n["id"] for n in whole["nodes"]] != ["a1", "a2", "c1"]:
        raise Fail("--node なしの status が全ノードを出さない")


def check_readme(head):
    text = open(os.path.join(head, "README.md"), encoding="utf-8").read()
    missing = [w for w in ("waiting_on", "--role", "--node") if w not in text]
    if missing:
        raise Fail("README に " + "、".join(missing) + " の説明がない")


CHECKS = [
    ("waiting-on-ignores-settled", check_trap, True),
    ("waiting-on-lists-pending", check_wait_basic, False),
    ("ready-count", check_ready_count, False),
    ("ready-role", check_ready_role, False),
    ("status-node-filter", check_status_node, False),
    ("readme", check_readme, False),
]
