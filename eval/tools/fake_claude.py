#!/usr/bin/env python3
"""模擬の claude CLI（モデルを呼ばない）。`run-eval.sh dry` が、AHE の実行の流れ全体（fixture の複製・install・採点・台帳）を確かめるために使う。

本物の代わりに、依頼の文面から対象のタスクを見分け、eval/reference/<task>/<variant>/（E1b は eval/reference-e1b/）の参照解を作業ツリーに当てて、git にコミットする。
プロファイルの settings.json に hook があれば、本物の Claude Code と同じ入力（stdin の JSON）で、その hook を実際に実行する。
環境変数: FAKE_VARIANT = fixed（既定）| buggy | none、FAKE_VERIFY = 1 なら Skill(verify) を Edit の後・コミットの前に呼ぶ。
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

args = sys.argv[1:]
if args == ["--version"]:
    print("9.9.9 (Fake Claude Code)")
    sys.exit(0)

EVAL = Path(__file__).resolve().parent.parent
KEYS = {
    "changed_files": "trap-locale-decode", "load_tasks": "trap-fifo-bounded-read", "n_deltas": "trap-rejection-leak",
    "check(settings_path)": "trap-drift-scope", "format_size": "ctrl-format-size", "oldest_open": "ctrl-oldest-open",
    "format_problems": "ctrl-format-problems", "managed_events": "ctrl-managed-events",
}
prompt = sys.stdin.read()
task = next((t for k, t in KEYS.items() if k in prompt), None)
REF = EVAL / "reference"
if task is None:  # E1b: タスク YAML（tasks-e1b/）の依頼文と突き合わせる（AHE の Python には PyYAML がある）
    import yaml

    for tdir, rdir in (("tasks-e1b", "reference-e1b"), ("heldout/tasks", "heldout/reference")):  # held-out も同じ形
        for y in sorted((EVAL / tdir).glob("*.yaml")):
            d = yaml.safe_load(y.read_text(encoding="utf-8"))
            if str(d.get("prompt", "")).strip() and str(d["prompt"]).strip() in prompt:
                task, REF = d["id"], EVAL / rdir
                break
        if task is not None:
            break
variant = os.environ.get("FAKE_VARIANT", "fixed")
cwd = Path.cwd()
events = []


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def tool(name, inp):
    tid = f"toolu_{len(events)}"
    events.append(tid)
    emit({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}],
                                           "usage": {"input_tokens": 10, "output_tokens": 5}}})
    emit({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": "ok"}]}})


def run_hooks(matcher_tool, hook_input):
    """settings.json の PostToolUse hook のうち、matcher が当たるものを本物と同じ入力で実行する。"""
    settings = Path(os.environ.get("CLAUDE_CONFIG_DIR", "")) / "settings.json"
    if not settings.is_file():
        return
    for group in json.loads(settings.read_text()).get("hooks", {}).get("PostToolUse", []):
        if matcher_tool not in group.get("matcher", "").split("|"):
            continue
        for h in group.get("hooks", []):
            cond = h.get("if")
            if cond and not (cond.startswith("Bash(git commit") and matcher_tool == "Bash"):
                continue
            r = subprocess.run([h["command"], *h.get("args", [])], input=json.dumps(hook_input), capture_output=True, text=True, cwd=cwd)
            emit({"type": "system", "subtype": "hook_response", "hook_name": f"PostToolUse:{matcher_tool}", "exit_code": r.returncode,
                  "outcome": "success" if r.returncode == 0 else "error"})


emit({"type": "system", "subtype": "init", "claude_code_version": "9.9.9", "model": "fake", "skills": ["verify"], "plugins": []})
base = {"session_id": "fake-session", "cwd": str(cwd)}
if task and variant != "none":
    src = REF / task / variant
    if not src.is_dir():
        src = REF / task / "fixed"
    for f in sorted(p for p in src.rglob("*") if p.is_file()):
        dest = cwd / f.relative_to(src)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dest)
        tool("Edit", {"file_path": str(dest), "old_string": "", "new_string": "x"})
if os.environ.get("FAKE_VERIFY") == "1":
    tool("Skill", {"skill": "verify"})
    run_hooks("Skill", {**base, "tool_name": "Skill", "tool_input": {"skill": "verify"}})
if task and variant != "none":
    subprocess.run(["git", "add", "-A"], cwd=cwd, check=True)
    tool("Bash", {"command": "git commit -m change"})
    subprocess.run(["git", "commit", "-q", "-m", "change"], cwd=cwd, check=True)
    run_hooks("Bash", {**base, "tool_name": "Bash", "tool_input": {"command": "git commit -m change"}})
emit({"type": "result", "subtype": "success", "is_error": False, "result": "done", "num_turns": len(events) + 1, "duration_ms": 1,
      "total_cost_usd": 0.0, "usage": {"input_tokens": 10, "output_tokens": 5}})
