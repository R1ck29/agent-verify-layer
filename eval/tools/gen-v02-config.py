#!/usr/bin/env python3
"""P2（Verify v0.2）の設定を、公開されている fixture の情報だけから機械的に作る（モデルは呼ばない。人が fixture を見て調整しない）。

使い方: gen-v02-config.py WORKDIR CONFIG_DIR [--log PATH] [--on-unsupported unverified|error]
  WORKDIR    = fixture を複製した作業ツリー（install の時点。層の部品は入っていてもよい）
  CONFIG_DIR = v0.2 の VL_CONFIG_DIR（Claude なら {config_dir}/verify-layer）。ここに config.json と generated.json（生成の記録）を書く

規則（V02-DESIGN §3.2。追補 B で事前登録する）:
  runner:  pytest の設定がある（pytest.ini／setup.cfg の [tool:pytest]／tox.ini の [pytest]／pyproject.toml の [tool.pytest）→ "pytest"
           なければ package.json の scripts.test が `node --test` → "node"
           どちらでもない（unittest・jest など）→ "unsupported"（V02-DESIGN §3.2・§4.1）。--on-unsupported unverified（既定）は強制モードのまま
           （v0.2 は「未検証（対応外ランナー）」で終わる = 層の費用として数える。Opus の (b)）、error は終了コード 3（その fixture を除外する運用 (a) 用）
  protectedPaths: テスト専用の既定の集合（tests・test・pytest.ini・conftest.py）のうち fixture に存在するもの + ルート直下の test_*.py・*_test.py。
           ソート済み。多用途ファイル（package.json・pyproject.toml・setup.cfg・tox.ini）は入れない（v0.2 が §2.4 の項目単位で保護）
  includePaths: 付けない
  mode: enforce、adversarial: false（PREREG 追補 A）。トップレベルの mode は observe（v0.1 の hook 用。v0.2 の Stop は verifyV2.mode が決める）
"""
import argparse
import json
import re
import sys
from pathlib import Path

# テスト専用のパスだけ（V02-DESIGN §4.1-3）。package.json・pyproject.toml・setup.cfg・tox.ini などの多用途ファイルは v0.2 が項目単位で保護する
DEFAULT_PROTECTED = ("tests", "test", "pytest.ini", "conftest.py")
ROOT_TEST = re.compile(r"^(test_[^/]+\.py|[^/]+_test\.py)$")
NODE_TEST = re.compile(r"\bnode\b[^&|;]*--test\b")


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def detect_runner(wd: Path):
    """(runner または None, 理由)。"""
    if (wd / "pytest.ini").is_file():
        return "pytest", "pytest.ini がある"
    if re.search(r"^\[tool:pytest\]", read(wd / "setup.cfg"), re.M):
        return "pytest", "setup.cfg に [tool:pytest] がある"
    if re.search(r"^\[pytest\]", read(wd / "tox.ini"), re.M):
        return "pytest", "tox.ini に [pytest] がある"
    if re.search(r"^\[tool\.pytest", read(wd / "pyproject.toml"), re.M):
        return "pytest", "pyproject.toml に [tool.pytest がある"
    try:
        test = str((json.loads(read(wd / "package.json") or "{}").get("scripts") or {}).get("test", ""))
    except (ValueError, AttributeError):
        test = ""
    if NODE_TEST.search(test):
        return "node", f"package.json の scripts.test が node --test（{test[:60]}）"
    return None, "対応外ランナー（pytest の設定も node --test の scripts.test もない）"


def protected_paths(wd: Path):
    found = {p for p in DEFAULT_PROTECTED if (wd / p).exists()}
    found |= {p.name for p in wd.iterdir() if p.is_file() and ROOT_TEST.match(p.name)}
    return sorted(found)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workdir")
    ap.add_argument("config_dir")
    ap.add_argument("--log")
    ap.add_argument("--on-unsupported", choices=("unverified", "error"), default="unverified")
    a = ap.parse_args(argv)
    wd = Path(a.workdir)
    runner, reason = detect_runner(wd)
    if runner is None and a.on_unsupported == "error":
        print(f"gen-v02-config: {reason}", file=sys.stderr)
        return 3
    v2 = {"mode": "enforce", "adversarial": False, "protectedPaths": protected_paths(wd)}
    v2["runner"] = runner or "unsupported"
    config = {"mode": "observe", "verifyV2": v2}
    record = {"runner": runner, "unsupported": runner is None, "reason": reason, "config": config}
    cdir = Path(a.config_dir)
    cdir.mkdir(parents=True, exist_ok=True)
    text = json.dumps(config, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    (cdir / "config.json").write_text(text, encoding="utf-8")
    rec_text = json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    (cdir / "generated.json").write_text(rec_text, encoding="utf-8")
    if a.log:  # 試行ログ（試行ルート。解答からは見えない）にも残す
        Path(a.log).parent.mkdir(parents=True, exist_ok=True)
        Path(a.log).write_text(rec_text, encoding="utf-8")
    print(f"gen-v02-config: runner={runner or '対応外'}（{reason}）protectedPaths={v2['protectedPaths']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
