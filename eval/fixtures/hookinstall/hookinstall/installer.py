"""settings.json の "hooks" に、このツールが管理する hook を入れる・外す。

settings.json の形:
  {"hooks": {"<イベント名>": [{"matcher": "...", "hooks": [{"type": "command", "command": "...", "timeout": 10}]}]}}
他のツールが入れた hook や、hooks 以外のキーは、そのまま残す。
"""
import json
import os

MANAGED_COMMANDS = {
    "SessionStart": "python3 /opt/harness/hook.py start",
    "PostToolUse": "python3 /opt/harness/hook.py tool",
}
TIMEOUT = 10


def _read(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _is_ours(group):
    return any(h.get("command") in MANAGED_COMMANDS.values() for h in group.get("hooks", []))


def _our_group(command):
    return {"matcher": "", "hooks": [{"type": "command", "command": command, "timeout": TIMEOUT}]}


def install(path):
    """管理する hook を入れる。すでに入っていれば置き換える（重複させない）。自分のものは各イベントの末尾に置く。"""
    settings = _read(path)
    hooks = settings.setdefault("hooks", {})
    for event, command in MANAGED_COMMANDS.items():
        groups = [g for g in hooks.get(event, []) if not _is_ours(g)]
        groups.append(_our_group(command))
        hooks[event] = groups
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(settings, fh, ensure_ascii=False, indent=2)


def uninstall(path):
    """管理する hook だけを外す。"""
    settings = _read(path)
    hooks = settings.get("hooks", {})
    for event in MANAGED_COMMANDS:
        if event in hooks:
            hooks[event] = [g for g in hooks[event] if not _is_ours(g)]
            if not hooks[event]:
                del hooks[event]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(settings, fh, ensure_ascii=False, indent=2)
