# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""git の作業ツリーで、HEAD から変わったファイルを調べる。"""
import subprocess


def changed_files(repo):
    """repo の作業ツリーで、HEAD から変更・追加されたファイル（未追跡を含む）の相対パスを、ソートして返す。"""
    result = subprocess.run(
        ["git", "-C", repo, "status", "--porcelain", "-z", "--untracked-files=all"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return sorted(entry[3:] for entry in result.stdout.split("\0") if entry)
