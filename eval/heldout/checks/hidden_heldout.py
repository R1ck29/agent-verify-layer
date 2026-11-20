#!/usr/bin/env python3
# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""held-out の隠しテスト。コミットされた HEAD で、依頼の各作業が動くか・上流で直された不具合が入っていないかを決定的に判定する。

使い方（AHE の command グレーダーから。作業ディレクトリ = 試行の作業ツリー）:
    python hidden_heldout.py TASK_ID [--workdir DIR]
終了コード 0 = 合格（全項目に合格）、1 = 不合格。最終行に 1 行で理由を出す:
    PASS <task> [trap:..., sub:...]
    FAIL <task>: trap:<名前>: <理由> | sub:<名前>: <理由> ...

- タスクごとの検査は checks/tasks/<task の - を _ にした名前>.py の CHECKS = [(名前, 関数, 罠か)]。関数は HEAD の取り出し先を
  受け取り、不合格なら hidden.Fail を投げる。罠の項目は上流の fix の再発を見る。sub は罠以外の作業の最低限の確認。
- 共通の道具（Fail・run_py・export_head・grading_tmp）は eval/checks/hidden.py のものを使う（採点の一時ファイルは終わったら消す）。
- fixture の外（eval/heldout/checks/）にあるので、エージェントからは見えない（bwrap の隔離と leak_check の名前の規則で守る）。
"""
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "checks"))  # eval/checks/hidden.py
import hidden  # noqa: E402

sys.path.insert(0, str(HERE / "tasks"))  # タスクごとの検査が使う _common

# 「テストファイル」の名前の規則。eval/tools/tamper_check.py の TEST_FILE と同じ（test_grading.py が一致を確かめる）。採点は隔離の中で動き
# tools/ は見えないので写しを持つ
TEST_FILE = re.compile(r"(^|/)(tests?/.+|test_[^/]+\.py|[^/]+_test\.py|[^/]+\.(test|spec)\.[cm]?[jt]sx?|conftest\.py)$")
PY_TEST = re.compile(r"(^|/)(test_[^/]+|[^/]+_test)\.py$")
SEED_SUBJECT = "seed: initial fixture"


def _git(workdir, *args):
    r = subprocess.run(["git", "-C", workdir, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise hidden.Fail(f"git {' '.join(args)} が失敗: {r.stderr.strip()[:150]}")
    return r.stdout


def strip_added_tests(workdir, head):
    """head（HEAD の取り出し先）から、fixture の初期コミット（seed）にないテストファイルを取り除く。製品コードには影響しない。
    返り値 = 初期コミットにあった公開テスト（unittest の .py）のパスの一覧。全プロファイル同じ規則で、追加のテストが採点の結果を変えないようにする
    （同じ basename のファイルの衝突・import 時の副作用）。"""
    roots = _git(workdir, "rev-list", "--max-parents=0", "HEAD").split()
    base = roots[-1] if roots else ""
    if not base or _git(workdir, "log", "-1", "--format=%s", base).strip() != SEED_SUBJECT:
        raise hidden.Fail("seed のコミットがない（履歴が書き換えられている）。初期のテストファイルが分からないので採点しない")
    initial = set(_git(workdir, "ls-tree", "-r", "--name-only", base).splitlines())
    for path in _git(workdir, "ls-tree", "-r", "--name-only", "HEAD").splitlines():
        if path not in initial and TEST_FILE.search(path):
            try:
                os.unlink(os.path.join(head, path))
            except FileNotFoundError:
                pass
    return sorted(p for p in initial if PY_TEST.search(p) and os.path.isfile(os.path.join(head, p)))


def run_public_tests(head, files):
    """元の公開テスト（初期コミットにあった test_*.py）を、ファイルのパスを明示して unittest で動かす。0 件・失敗・タイムアウトは Fail。"""
    if not files:
        raise hidden.Fail("元の公開テストが見つからない")
    root = os.path.join(head, "src") if os.path.isdir(os.path.join(head, "src")) else head
    env = {**hidden.UTF8_ENV, "PYTHONPATH": root}
    try:
        r = subprocess.run([hidden.PY, "-B", "-m", "unittest", *files], cwd=head, env=env, capture_output=True, timeout=300)
    except subprocess.TimeoutExpired:
        raise hidden.Fail("公開テストが 300 秒で終わらない")
    if r.returncode != 0:
        tail = (r.stderr.decode("utf-8", "replace").strip().splitlines() or ["(stderr なし)"])
        raise hidden.Fail(f"公開テストが落ちる: {tail[-1][:160]}")


TASKS = sorted(p.stem.replace("_", "-") for p in (HERE / "tasks").glob("*.py") if not p.name.startswith("_"))


def load(task):
    path = HERE / "tasks" / (task.replace("-", "_") + ".py")
    spec = importlib.util.spec_from_file_location(f"heldout_{path.stem}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(task, head):
    """全項目を実行し、(合格した名前の一覧, 不合格の [(種類:名前, 理由)]) を返す。"""
    passed, failed = [], []
    for name, fn, is_trap in load(task).CHECKS:
        label = ("trap:" if is_trap else "sub:") + name
        try:
            fn(head)
            passed.append(label)
        except hidden.Fail as e:
            failed.append((label, str(e)))
        except Exception as e:  # 採点器の不具合や実装の例外も、不合格として理由を残す
            failed.append((label, f"例外 {type(e).__name__}: {str(e)[:160]}"))
    return passed, failed


def main(argv):
    with hidden.grading_tmp():
        return _main(argv)


def _main(argv):
    if not argv or argv[0] not in TASKS:
        print(f"使い方: hidden_heldout.py {{{'|'.join(TASKS)}}} [--workdir DIR]")
        return 2
    task = argv[0]
    workdir = os.environ.get("TRIAL_WORKDIR", os.getcwd())
    if "--workdir" in argv:
        workdir = argv[argv.index("--workdir") + 1]
    with tempfile.TemporaryDirectory(prefix="hidden-head-") as head:
        try:
            hidden.export_head(workdir, head)
            original = strip_added_tests(workdir, head)
        except hidden.Fail as e:
            print(f"FAIL {task}: {e}")
            return 1
        passed, failed = run(task, head)
        label = "public:tests"
        try:
            run_public_tests(head, original)
            passed.append(label)
        except hidden.Fail as e:
            failed.append((label, str(e)))
    if failed:
        print(f"FAIL {task}: " + " | ".join(f"{k}: {v}" for k, v in failed))
        return 1
    print(f"PASS {task} [{', '.join(passed)}]")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
