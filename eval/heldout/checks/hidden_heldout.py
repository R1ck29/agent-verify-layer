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
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "checks"))  # eval/checks/hidden.py
import hidden  # noqa: E402

sys.path.insert(0, str(HERE / "tasks"))  # タスクごとの検査が使う _common

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
