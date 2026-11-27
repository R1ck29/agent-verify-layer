"""git の作業ツリーで、HEAD から変わったファイルを調べる。"""
import subprocess


def changed_files(repo):
    """repo の作業ツリーで、HEAD から変更・追加されたファイル（未追跡を含む）の相対パスを、ソートして返す。"""
    result = subprocess.run(
        ["git", "-C", repo, "status", "--porcelain", "-z", "--untracked-files=all"],
        capture_output=True,
        text=True,
        check=True,
    )
    return sorted(entry[3:] for entry in result.stdout.split("\0") if entry)
