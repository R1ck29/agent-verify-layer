# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""タスク一覧の JSON ファイルへの保存。形式は {"tasks": [...]}。"""
import json
import os
import stat
import tempfile

from . import StoreError


def save_tasks(path, tasks):
    """tasks（辞書のリスト）を path に原子的に書く（一時ファイルに書いてから置き換える）。"""
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"tasks": list(tasks)}, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError as exc:
        raise StoreError(f"cannot save {path}: {exc}") from exc
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


MAX_BYTES = 1048576


def load_tasks(path):
    """path の JSON（{"tasks": [...]}）を読んで tasks を返す。1 MiB を超えるファイルは StoreError。"""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    except OSError as exc:
        raise StoreError(f"cannot open {path}: {exc}") from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise StoreError(f"{path} is not a regular file")
        with os.fdopen(fd, "rb", closefd=False) as fh:
            raw = fh.read(MAX_BYTES + 1)
    except OSError as exc:
        raise StoreError(f"cannot read {path}: {exc}") from exc
    finally:
        os.close(fd)
    if len(raw) > MAX_BYTES:
        raise StoreError(f"{path} is larger than {MAX_BYTES} bytes")
    try:
        return json.loads(raw.decode("utf-8"))["tasks"]
    except (ValueError, KeyError) as exc:
        raise StoreError(f"cannot parse {path}: {exc}") from exc
