#!/usr/bin/env python3
"""3 つのプロファイルの install を、AHE の実際の準備（fixture の複製 → install）と同じ手順で一時ディレクトリに行い、結果を確かめる。
モデルは呼ばない。使い方: PYTHONPATH=<AHE> python install-check.py（run-eval.sh と selftest.sh が使う）。終了コード 0 = すべて期待どおり。"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from harness_eval.isolation import build_env, make_trial_paths, run_install
from harness_eval.spec import load_profile

EVAL = Path(__file__).resolve().parent.parent
bad = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        bad.append(msg)


def git(wd, *a):
    return subprocess.run(["git", "-C", str(wd), *a], capture_output=True, text=True)


def prepare(profile_yaml, fixture):
    profile = load_profile(EVAL / "profiles" / profile_yaml)
    tp = make_trial_paths(Path(tempfile.mkdtemp()) / "t", ".claude")
    shutil.copytree(EVAL / "fixtures" / fixture, tp.workdir, dirs_exist_ok=True)
    run_install(profile, tp, build_env(profile, tp, "CLAUDE_CONFIG_DIR"))
    return profile, tp


for name in ("claude-baseline", "claude-static-rules", "claude-verify-layer"):
    print(f"== {name}")
    profile, tp = prepare(f"{name}.yaml", "taskstore")
    wd, cfg = tp.workdir, tp.config_dir
    check(profile.model == "sonnet" and profile.billing == "subscription" and profile.inherit_env == ["CLAUDE_CODE_OAUTH_TOKEN"],
          "model: sonnet / billing: subscription / inherit_env は CLAUDE_CODE_OAUTH_TOKEN だけ")
    check(not profile.env, "env に固定値がない（トークンなどを書いていない）")
    check(git(wd, "rev-list", "--count", "HEAD").stdout.strip() == "1", "作業ツリーが 1 コミットの git リポジトリ")
    check(git(wd, "show", "HEAD:.claude/verification/checklist.json").returncode == 0, "checklist.json が HEAD にコミット済み")
    check(git(wd, "show", "HEAD:.claude/skills/verify/SKILL.md").returncode == 0, "verify スキルが HEAD にコミット済み")
    check(git(wd, "status", "--porcelain").stdout.strip() == "", "作業ツリーが clean")
    check(bool(git(wd, "config", "user.email").stdout.strip()), "コミットの作者が設定済み（一時ホームに git の設定がない）")
    files = sorted(p.relative_to(cfg).as_posix() for p in cfg.rglob("*") if p.is_file())
    if name == "claude-baseline":
        check(files == [], f"設定ディレクトリが空（{files}）")
    elif name == "claude-static-rules":
        check(files == ["CLAUDE.md"], f"設定ディレクトリは CLAUDE.md だけ（{files}）")
        want = (EVAL / "profiles/static-rules/CLAUDE.md").read_text(encoding="utf-8")
        check((cfg / "CLAUDE.md").read_text(encoding="utf-8") == want, "CLAUDE.md が static-rules の生成物と同じ")
        items = json.loads((wd / ".claude/verification/checklist.json").read_text())["items"]
        check(all(f"[{i['id']}]" in want for i in items), f"checklist の全 {len(items)} 項目が CLAUDE.md にある")
    else:
        settings = json.loads((cfg / "settings.json").read_text())
        hooks = settings.get("hooks", {})
        handlers = {ev: [h for g in groups for h in g["hooks"]] for ev, groups in hooks.items()}
        vl = (EVAL.parent / "scripts/vl.js").resolve()
        check(set(handlers) == {"PostToolUse", "UserPromptExpansion"}, f"settings.json の hook イベント: {sorted(handlers)}")
        post = [h for h in handlers.get("PostToolUse", [])]
        sub = sorted(h["args"][-1] for h in post)
        check(sub == ["commit", "commit", "skill"] and all(Path(h["args"][0]).resolve() == vl for h in post),
              f"PostToolUse が vl.js の絶対パスで skill と commit を呼ぶ（{sub}）")
        check(vl.exists(), "vl.js が存在する")
        check((cfg / "verify-layer/config.json").read_text().strip().replace(" ", "").replace("\n", "") == '{"mode":"observe"}',
              "観察モードの設定が置かれた")
        check((cfg / "rules/verification.md").exists(), "Rules（2 行）が置かれた")
        check(not re.search(r"oauth|token|sk-ant", json.dumps(settings), re.I), "settings.json に認証情報らしい文字列がない")
print("install-check: " + ("すべて期待どおり" if not bad else f"失敗 {len(bad)} 件"))
sys.exit(1 if bad else 0)
