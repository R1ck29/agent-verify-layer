"""タスク一覧の JSON ファイルへの保存。形式は {"tasks": [...]}。"""
import json
import os
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
