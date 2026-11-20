#!/usr/bin/env python3
# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""E1b の隠しテスト。コミットされた HEAD で、チケットの各作業が動くか・元の不具合が再発していないかを決定的に判定する。

使い方（AHE の command グレーダーから。作業ディレクトリ = 試行の作業ツリー）:
    python hidden_e1b.py TASK_ID [--workdir DIR]
終了コード 0 = 合格（全項目に合格）、1 = 不合格。最終行に 1 行で理由を出す:
    PASS <task> [trap:..., sub:...]
    FAIL <task>: trap:<名前>: <理由> | sub:<名前>: <理由> ...

- タスクごとの検査は checks/e1b/<task の - を _ にした名前>.py の CHECKS = [(名前, 関数, 罠か)]。関数は HEAD の取り出し先を受け取り、
  不合格なら hidden.Fail を投げる。罠の項目は元の fix の再発を見る。それ以外の項目（sub）は、罠以外の作業の最低限の確認。
- 判定するのは HEAD のスナップショットだけ（`git archive HEAD`）。コミットされていない変更は見ない。
- fixture の外（eval/checks/）にあるので、エージェントからは見えない。
"""
import importlib.util
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import hidden  # noqa: E402  共通の道具（Fail、run_py、export_head、git、環境変数）

TASKS = sorted(p.stem.replace("_", "-") for p in (HERE / "e1b").glob("*.py") if not p.name.startswith("_"))


def load(task):
    path = HERE / "e1b" / (task.replace("-", "_") + ".py")
    spec = importlib.util.spec_from_file_location(f"e1b_{path.stem}", path)
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
        except Exception as e:  # 採点器の不具合や、実装の例外も不合格として理由を残す
            failed.append((label, f"例外 {type(e).__name__}: {str(e)[:160]}"))
    return passed, failed


def main(argv):
    with hidden.grading_tmp():
        return _main(argv)


def _main(argv):
    if not argv or argv[0] not in TASKS:
        print(f"使い方: hidden_e1b.py {{{'|'.join(TASKS)}}} [--workdir DIR]")
        return 2
    task = argv[0]
    workdir = os.environ.get("TRIAL_WORKDIR", os.getcwd())
    if "--workdir" in argv:
        workdir = argv[argv.index("--workdir") + 1]
    # 取り出し先は採点のあいだだけ置き、必ず消す（以前は /tmp/hidden-head-* が残り、隠しテストを当てた木が後の試行から読めた）。
    # 置き場所は hidden.grading_tmp() の中（VL_GRADE_TMP で変更可）。解答側は bwrap で /tmp を別にしてあるので、ここは見えない
    with tempfile.TemporaryDirectory(prefix="hidden-head-") as head:
        try:
            hidden.export_head(workdir, head)
        except hidden.Fail as e:
            print(f"FAIL {task}: {e}")
            return 1
        passed, failed = run(task, head)
    if failed:
        print(f"FAIL {task}: " + " | ".join(f"{k}: {v}" for k, v in failed))
        return 1
    print(f"PASS {task} [{', '.join(passed)}]")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
