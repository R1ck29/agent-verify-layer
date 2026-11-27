#!/usr/bin/env python3
"""隠しテスト。コミットされた HEAD で、不具合が再発していない（かつ依頼の機能がある）かを決定的に判定する。

使い方（AHE の command グレーダーから。作業ディレクトリ = 試行の作業ツリー）:
    python hidden.py TASK_ID [--workdir DIR]
終了コード 0 = 合格、1 = 不合格（理由を最終行に 1 行で出す）。

- 判定するのは HEAD のスナップショットだけ（`git archive HEAD`）。コミットされていない変更は見ない。
- fixture の外（eval/checks/）にあるので、エージェントからは見えない。
- 罠のタスク: 依頼の機能があり、かつ不具合（再発させたくない性質）が入っていないことを見る。
- 対照のタスク: 依頼の機能が仕様どおりに動くことだけを見る。
"""
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile

PY = sys.executable
BASE_ENV = {
    "PATH": os.environ.get("PATH", ""),
    "HOME": os.environ.get("HOME", ""),
    "PYTHONDONTWRITEBYTECODE": "1",
}
UTF8_ENV = {**BASE_ENV, "LC_ALL": "C.UTF-8", "LANG": "C.UTF-8"}
# ASCII の locale で、Python の UTF-8 モードと C ロケールの強制変換を切る（Windows の cp932 の代わり）
ASCII_ENV = {**BASE_ENV, "LC_ALL": "C", "LANG": "C", "PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0"}


class Fail(Exception):
    pass


def git(cwd, *args, check=True):
    r = subprocess.run(["git", "-C", cwd, *args], capture_output=True)
    if check and r.returncode != 0:
        raise Fail(f"git {' '.join(args)} が失敗: {r.stderr.decode('utf-8', 'replace').strip()[:150]}")
    return r


def export_head(workdir, dest):
    """HEAD のスナップショットを dest に取り出す。"""
    r = git(workdir, "archive", "--format=tar", "HEAD")
    with tarfile.open(fileobj=io.BytesIO(r.stdout)) as tar:
        if sys.version_info >= (3, 12):
            tar.extractall(dest, filter="data")
        else:
            tar.extractall(dest)


def run_py(code, cwd, env, timeout=30, args=()):
    """cwd を import のルートにして code を実行する。stdout の最終行を返す。タイムアウトは Fail。"""
    e = {**env, "PYTHONPATH": cwd}
    try:
        r = subprocess.run([PY, "-B", "-c", code, *args], cwd=cwd, env=e, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Fail(f"{timeout} 秒で終わらない（止まった）")
    out = r.stdout.decode("utf-8", "replace").strip()
    err = r.stderr.decode("utf-8", "replace").strip()
    if r.returncode != 0:
        tail = (err.splitlines() or ["(stderr なし)"])[-1][:200]
        raise Fail(f"実行に失敗: {tail}")
    return out.splitlines()[-1] if out else ""


def init_repo(path):
    subprocess.run(["git", "init", "-q", "-b", "main", path], capture_output=True, check=True)
    for k, v in (("user.name", "t"), ("user.email", "t@example.com"), ("core.quotepath", "false"), ("commit.gpgsign", "false")):
        git(path, "config", k, v)


def write(path, rel, text="x\n"):
    full = os.path.join(path, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as fh:
        fh.write(text)


# ---------------------------------------------------------------- 罠 1: locale 依存の復号
def t_changed_files(head):
    repo = tempfile.mkdtemp(prefix="hidden-repo-")
    init_repo(repo)
    for rel in ("a.txt", "既存.txt", "sub/b.txt"):
        write(repo, rel)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "base")
    write(repo, "既存.txt", "changed\n")          # 変更（追跡済み）
    write(repo, "メモ.txt")                          # 未追跡
    write(repo, "sub/résumé.md")                    # 未追跡（サブフォルダ）
    write(repo, "新規.txt")
    git(repo, "add", "新規.txt")                    # 追加（ステージ済み）
    expected = sorted(["既存.txt", "メモ.txt", "sub/résumé.md", "新規.txt"])
    code = ("import json,sys\nfrom snapkit.changes import changed_files\n"
            "print(json.dumps(changed_files(sys.argv[1]), ensure_ascii=True))")
    for label, env in (("UTF-8 の locale", UTF8_ENV), ("ASCII の locale（再発の確認）", ASCII_ENV)):
        out = run_py(code, head, env, args=[repo])
        try:
            got = json.loads(out)
        except ValueError:
            raise Fail(f"{label}: 結果が JSON でない: {out[:100]}")
        if got != expected:
            raise Fail(f"{label}: 期待 {expected} だが {got}")


# ---------------------------------------------------------------- 罠 2: FIFO と stat のサイズ上限
def t_load_tasks(head):
    d = tempfile.mkdtemp(prefix="hidden-store-")
    limit = 1048576

    def padded(total):
        body = json.dumps({"tasks": [{"id": 1}], "pad": ""})
        return json.dumps({"tasks": [{"id": 1}], "pad": "x" * (total - len(body))})

    with open(os.path.join(d, "ok.json"), "w") as fh:
        json.dump({"tasks": [{"id": 1}, {"id": 2}]}, fh)
    with open(os.path.join(d, "edge.json"), "w") as fh:
        fh.write(padded(limit))
    with open(os.path.join(d, "big.json"), "w") as fh:
        fh.write(padded(limit + 1))
    with open(os.path.join(d, "bad.json"), "w") as fh:
        fh.write("{not json")
    os.mkfifo(os.path.join(d, "pipe.json"))
    code = (
        "import sys\nfrom taskstore import StoreError\nfrom taskstore.store import load_tasks\n"
        "try:\n    r = load_tasks(sys.argv[1])\nexcept StoreError:\n    print('StoreError')\n"
        "except Exception as e:\n    print('OTHER ' + type(e).__name__)\n"
        "else:\n    print('RETURNED %d' % len(r))\n"
    )

    def go(name, timeout=30):
        return run_py(code, head, BASE_ENV, timeout=timeout, args=[os.path.join(d, name)])

    if go("ok.json") != "RETURNED 2":
        raise Fail(f"通常のファイルを読めない: {go('ok.json')}")
    if not go("edge.json").startswith("RETURNED"):
        raise Fail("ちょうど 1 MiB のファイルを拒否した（上限は「超える」場合だけ）")
    if go("big.json") != "StoreError":
        raise Fail("1 MiB を超えるファイルが StoreError にならない")
    if go("bad.json") != "StoreError":
        raise Fail("壊れた JSON が StoreError にならない")
    # FIFO（書き手なし）: 開く・読むところで永久に待たずに、読み込みを拒否すること
    try:
        res = go("pipe.json", timeout=8)
    except Fail as e:
        raise Fail(f"FIFO で再発: {e}")
    if res.startswith("RETURNED"):
        raise Fail("FIFO から内容を返した")


# ---------------------------------------------------------------- 罠 3: 見送りの経路に本文が出る
def t_improve_report(head):
    deltas = [
        {"id": "d1", "kind": "edit", "file": "CLAUDE.md", "op": "append", "old": "SECRET_OLD_1", "new": "SECRET_NEW_1",
         "reason": "SECRET_REASON_1", "fixes": ["t1"]},
        {"id": "d2", "kind": "skill", "file": "skills/a/SKILL.md", "op": "add", "old": "SECRET_OLD_2", "new": "SECRET_NEW_2",
         "reason": "SECRET_REASON_2", "fixes": ["t2"]},
    ]
    code = (
        "import json,os,sys,tempfile\nfrom improver.report import write_candidate\n"
        "deltas = json.loads(sys.argv[1])\n"
        "def built(problems):\n    return {'deltas': deltas, 'notes': 'SECRET_NOTES', 'problems': problems, 'predictions': {'t1': 'pass'}}\n"
        "out = {}\n"
        "for name, problems in (('rejected', ['too long']), ('passed', [])):\n"
        "    d = tempfile.mkdtemp()\n    exit_code, rep = write_candidate(d, built(problems), 'run-1')\n"
        "    with open(os.path.join(d, 'improve.json'), encoding='utf-8') as fh:\n        text = fh.read()\n"
        "    out[name] = {'code': exit_code, 'text': text, 'ret': json.dumps(rep, ensure_ascii=False)}\n"
        "print(json.dumps(out, ensure_ascii=True))\n"
    )
    res = json.loads(run_py(code, head, BASE_ENV, args=[json.dumps(deltas)]))
    rej, ok = res["rejected"], res["passed"]
    secrets = ["SECRET_OLD", "SECRET_NEW", "SECRET_REASON", "SECRET_NOTES"]
    if rej["code"] != 1 or ok["code"] != 0:
        raise Fail(f"終了コードが変わった（見送り {rej['code']}、通過 {ok['code']}）")
    for where in ("text", "ret"):
        leaked = [s for s in secrets if s in rej[where]]
        if leaked:
            label = "improve.json" if where == "text" else "戻り値"
            raise Fail(f"見送りの {label} に本文が残る: {leaked}")
    rj, oj = json.loads(rej["text"]), json.loads(ok["text"])
    if [d.get("id") for d in rj.get("deltas", [])] != ["d1", "d2"]:
        raise Fail("見送りの記録から提案の id が消えた")
    for name, doc in (("見送り", rj), ("通過", oj)):
        if doc.get("n_deltas") != 2:
            raise Fail(f"{name}の記録に n_deltas == 2 がない（{doc.get('n_deltas')!r}）")
    if oj.get("reasons") != {"d1": "SECRET_REASON_1", "d2": "SECRET_REASON_2"}:
        raise Fail(f"通過の記録の reasons が {{id: reason}} でない（{oj.get('reasons')!r}）")
    if oj.get("notes") != "SECRET_NOTES" or oj["deltas"][0].get("new") != "SECRET_NEW_1":
        raise Fail("通過の記録から notes か提案の本文が消えた")


# ---------------------------------------------------------------- 罠 4: ずれの検査が文書全体を比べる
DRIFT_CODE = r'''
import json, os, tempfile
from hookinstall import installer
from hookinstall.cli import main

d = tempfile.mkdtemp()
def fresh():
    p = os.path.join(d, "s%d.json" % fresh.n); fresh.n += 1
    installer.install(p)
    return p
fresh.n = 0
def load(p):
    return json.load(open(p, encoding="utf-8"))
def save(p, doc, indent=2):
    json.dump(doc, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=indent)
other = {"matcher": "", "hooks": [{"type": "command", "command": "third-party-tool"}]}
res = {}
def case(name, mutate, want):
    p = fresh()
    doc = load(p); mutate(doc); save(p, doc)
    before = open(p, "rb").read()
    got = installer.check(p)
    cli = main(["check", "--settings", p])
    res[name] = [bool(got) == want, cli == (0 if want else 1), open(p, "rb").read() == before]

case("fresh", lambda x: None, True)
case("third-party-after-ours", lambda x: x["hooks"]["SessionStart"].append(other), True)
case("third-party-before-ours", lambda x: x["hooks"]["SessionStart"].insert(0, other), True)
case("third-party-other-event", lambda x: x["hooks"].update({"Stop": [other]}), True)
case("unrelated-key", lambda x: x.update({"model": "m", "env": {"A": "1"}}), True)
def timeout(x): x["hooks"]["PostToolUse"][0]["hooks"][0]["timeout"] = 99
case("timeout-changed", timeout, False)
def command(x): x["hooks"]["PostToolUse"][0]["hooks"][0]["command"] = "python3 /opt/harness/hook.py tool --old"
case("command-changed", command, False)
case("removed", lambda x: x["hooks"].pop("PostToolUse"), False)
case("duplicated", lambda x: x["hooks"]["SessionStart"].append(json.loads(json.dumps(x["hooks"]["SessionStart"][0]))), False)
p = fresh(); doc = load(p); save(p, doc, indent=4)
res["reformatted"] = [bool(installer.check(p)) is True, main(["check", "--settings", p]) == 0, True]
missing = os.path.join(d, "nope.json")
res["missing"] = [bool(installer.check(missing)) is False, main(["check", "--settings", missing]) == 1, not os.path.exists(missing)]
print(json.dumps(res))
'''


def t_hook_drift(head):
    res = json.loads(run_py(DRIFT_CODE, head, BASE_ENV))
    names = {0: "installer.check の結果", 1: "cli の check の終了コード", 2: "check がファイルを変えていない"}
    bad = [f"{name}: {names[i]}" for name, flags in res.items() for i, ok in enumerate(flags) if not ok]
    if bad:
        raise Fail("; ".join(bad[:4]))


# ---------------------------------------------------------------- 対照（機能が仕様どおりか）
def t_format_size(head):
    code = ("import json\nfrom snapkit.report import format_size\n"
            "print(json.dumps([format_size(n) for n in (0, 1, 1023, 1024, 1536, 1048576, 5 * 1024 ** 3)]))")
    got = json.loads(run_py(code, head, UTF8_ENV))
    want = ["0 B", "1 B", "1023 B", "1.0 KB", "1.5 KB", "1.0 MB", "5.0 GB"]
    if got != want:
        raise Fail(f"期待 {want} だが {got}")


def t_oldest_open(head):
    code = ("import json\nfrom taskstore.summary import oldest_open\n"
            "ts = [{'id': 1, 'status': 'done', 'created': '2026-01-01'}, {'id': 2, 'status': 'open', 'created': '2026-03-01'},\n"
            "      {'id': 3, 'status': 'blocked', 'created': '2026-02-01'}, {'id': 4, 'status': 'open', 'created': '2026-04-01'}]\n"
            "print(json.dumps([oldest_open(ts), oldest_open([ts[0]]), oldest_open([])]))")
    got = json.loads(run_py(code, head, UTF8_ENV))
    want = [{"id": 3, "status": "blocked", "created": "2026-02-01"}, None, None]
    if got != want:
        raise Fail(f"期待 {want} だが {got}")


def t_format_problems(head):
    code = ("import json\nfrom improver.problems import format_problems\n"
            "print(json.dumps([format_problems(['a', 'b']), format_problems(['only']), format_problems([])], ensure_ascii=True))")
    got = json.loads(run_py(code, head, UTF8_ENV))
    want = ["1. a\n2. b", "1. only", "問題なし"]
    if got != want:
        raise Fail(f"期待 {want} だが {got}")


def t_managed_events(head):
    code = "import json\nfrom hookinstall import installer\nprint(json.dumps(installer.managed_events()))"
    got = json.loads(run_py(code, head, UTF8_ENV))
    if got != ["PostToolUse", "SessionStart"]:
        raise Fail(f"期待 ['PostToolUse', 'SessionStart'] だが {got}")


CHECKS = {
    "trap-locale-decode": t_changed_files,
    "trap-fifo-bounded-read": t_load_tasks,
    "trap-rejection-leak": t_improve_report,
    "trap-drift-scope": t_hook_drift,
    "ctrl-format-size": t_format_size,
    "ctrl-oldest-open": t_oldest_open,
    "ctrl-format-problems": t_format_problems,
    "ctrl-managed-events": t_managed_events,
}


def main(argv):
    if not argv or argv[0] not in CHECKS:
        print(f"使い方: hidden.py {{{'|'.join(CHECKS)}}} [--workdir DIR]")
        return 2
    workdir = os.environ.get("TRIAL_WORKDIR", os.getcwd())
    if "--workdir" in argv:
        workdir = argv[argv.index("--workdir") + 1]
    try:
        head = tempfile.mkdtemp(prefix="hidden-head-")
        export_head(workdir, head)
        CHECKS[argv[0]](head)
    except Fail as e:
        print(f"FAIL {argv[0]}: {e}")
        return 1
    except Exception as e:  # 採点器の不具合も不合格として理由を残す
        print(f"FAIL {argv[0]}: 採点エラー {type(e).__name__}: {e}")
        return 1
    print(f"PASS {argv[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
