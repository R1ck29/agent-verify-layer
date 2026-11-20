#!/usr/bin/env python3
"""held-out の fixture を、上流の修正の親（base）から作る／作ったものが base の写しであることを確かめる。

使い方:
    build_fixtures.py build [FIXTURE...]   # reference/manifests/*.manifest.json から fixtures/<fixture>/ を作り直す
    build_fixtures.py check [FIXTURE...]   # 作り直した結果と fixtures/ が同じか・fixture に上流の手がかりがないか
上流のリポジトリの置き場: $HELDOUT_REPOS_DIR（既定 /workspace/verify-layer-work/heldout-repos/<repo>）。
置き場にないとき check はその fixture の「作り直しの比較」を SKIP する（漏れの走査は常に行う）。終了コード 1 = 食い違い・漏れ。

manifest（fixture の外。解答エージェントからは見えない reference/ の下）:
  repo, url, license, base, fix, fix_subject, tasks, keep（git archive の中で残すパスの glob）,
  upstream（fixture の本文に残してはいけない上流の手がかりの正規表現。本文全体で探す）,
  replace（{パス: [[正規表現, 置換], ...]}。テストの import の差し替えなど）, added（評価用に足すファイル）, changed（build が書く）。
書き換えは 3 種類だけ: (1) 上流を指すバッジ（.. image::）の塊を消す (2) 上流を指す URL を example.invalid にする
（RST の表の中のリンクは、表の幅を保つために同じ長さのリテラルにする） (3) manifest の replace。
"""
from __future__ import annotations

import fnmatch
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

HO = Path(__file__).resolve().parent.parent          # eval/heldout
EVAL = HO.parent
MANIFESTS = HO / "reference" / "manifests"
FIXTURES = HO / "fixtures"
REPOS = Path(os.environ.get("HELDOUT_REPOS_DIR", "/workspace/verify-layer-work/heldout-repos"))
# v0.1 の層がリポジトリに置くもの（E1b の fixture と同じもの。P0 では run-eval.sh が試行の前に外す）
LAYER_SRC = EVAL / "fixtures-e1b" / "wikiskill-a10000b"
LAYER_FILES = (".claude/skills/verify/SKILL.md", ".agents/skills/verify/SKILL.md", ".claude/verification/checklist.json")
TEXT_EXT = (".rst", ".md", ".toml", ".cfg", ".py", ".txt", ".ini", ".pyi")
URL = re.compile(r"https?://[^\s<>`\"')\]]+")
TABLE_LINK = re.compile(r"`([\w.]+) <(https?://[^>]+)>`_")


def manifests(names: list[str]) -> list[tuple[Path, dict]]:
    out = []
    for mf in sorted(MANIFESTS.glob("*.manifest.json")):
        m = json.loads(mf.read_text(encoding="utf-8"))
        if not names or m["fixture"] in names:
            out.append((mf, m))
    return out


def archive(repo: Path, sha: str) -> dict[str, bytes]:
    r = subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", sha], capture_output=True, check=True)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(r.stdout)) as tar:
        for member in tar.getmembers():
            if member.isfile():
                files[member.name] = tar.extractfile(member).read()
    return files


def scrub(text: str, upstream: re.Pattern) -> str:
    out, skipping, dropped = [], False, False
    for line in text.split("\n"):
        if skipping:
            if line.startswith((" ", "\t")) and line.strip():
                continue
            skipping = False
            if not line.strip() and out and not out[-1].strip():
                continue  # 消したバッジの塊のあとの空行は、前の空行と 1 つにする
        if line.lstrip().startswith(".. image::") and upstream.search(line):
            skipping = dropped = True
            continue
        if line.lstrip().startswith("|"):
            line = TABLE_LINK.sub(lambda m: (f"``{m[1]}``" + " " * (len(m[0]) - len(m[1]) - 4))
                                  if upstream.search(m[2]) else m[0], line)
        line = URL.sub(lambda m: "https://example.invalid/" if upstream.search(m[0]) else m[0], line)
        line = upstream.sub("example.invalid", line)  # URL の形でない参照（github.com/owner/repo など）
        out.append(line)
    return "\n".join(out) if (dropped or out != text.split("\n")) else text


def build_files(m: dict, repo: Path) -> tuple[dict[str, bytes], list[str]]:
    base = archive(repo, m["base"])
    upstream = re.compile("|".join(m["upstream"]), re.I)
    files, changed = {}, []
    missing = [g for g in m["keep"] if not any(fnmatch.fnmatchcase(r, g) for r in base)]
    if missing:
        raise SystemExit(f"{m['fixture']}: keep の {missing} が base にない")
    for rel, data in sorted(base.items()):
        if not any(fnmatch.fnmatchcase(rel, g) for g in m["keep"]):
            continue
        new = data
        if rel.endswith(TEXT_EXT) and not rel.split("/")[-1].startswith("LICENSE"):  # ライセンスは一字も変えない
            text = scrub(data.decode("utf-8"), upstream)
            for pat, rep in m.get("replace", {}).get(rel, []):
                text, n = re.subn(pat, rep, text, flags=re.M)
                if n == 0:
                    raise SystemExit(f"{m['fixture']}: replace の {pat!r} が {rel} に当たらない")
            new = text.encode("utf-8")
        files[rel] = new
        if new != data:
            changed.append(rel)
    for rel in LAYER_FILES:
        files[rel] = (LAYER_SRC / rel).read_bytes()
    return files, changed


def leaks(root: Path, m: dict) -> list[str]:
    """fixture の本文に、上流の手がかり（上流の URL・所有者名・修正の SHA）・評価の印・.git が残っていないか。"""
    pats = [re.compile("|".join(m["upstream"]), re.I), re.compile(m["fix"][:7]), re.compile("VL-EVAL-CANARY")]
    bad = []
    for p in sorted(root.rglob("*")):
        if p.name in (".git", "__pycache__"):
            bad.append(f"{p.relative_to(root)} がある")
            continue
        if p.is_dir():
            continue
        text = p.read_bytes().decode("utf-8", "replace")
        if p.name.startswith("LICENSE"):  # 著作権者の行はそのまま残す（ライセンスの条件）
            text = "\n".join(line for line in text.splitlines() if "Copyright" not in line)
        for rx in pats:
            hit = rx.search(text)
            if hit:
                bad.append(f"{p.relative_to(root)}: {hit.group(0)!r}")
    return bad


def tree(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)).replace(os.sep, "/"): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in ("build", "check"):
        print(__doc__)
        return 2
    cmd, names, bad = argv[0], argv[1:], 0
    for mf, m in manifests(names):
        root, repo = FIXTURES / m["fixture"], REPOS / m["repo"]
        have_repo = (repo / ".git").exists()
        if cmd == "build":
            files, changed = build_files(m, repo)
            if root.exists():
                shutil.rmtree(root)
            for rel, data in files.items():
                (root / rel).parent.mkdir(parents=True, exist_ok=True)
                (root / rel).write_bytes(data)
            m["changed"], m["added"] = changed, list(LAYER_FILES)
            mf.write_text(json.dumps(m, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
            print(f"  built {m['fixture']}: {len(files)} ファイル（changed {len(changed)}、added {len(LAYER_FILES)}）")
        errs = leaks(root, m) if root.exists() else [f"{root} がない"]
        if cmd == "check" and root.exists():
            if have_repo:
                want, changed = build_files(m, repo)
                have = tree(root)
                errs += [f"base の写しと違う: {r}" for r in sorted(set(want) | set(have)) if want.get(r) != have.get(r)]
                if sorted(changed) != sorted(m.get("changed", [])):
                    errs.append(f"manifest の changed が古い（build で作り直す）: {changed}")
            else:
                print(f"  SKIP {m['fixture']}: {repo} がない（作り直しの比較を飛ばし、漏れの走査だけ行う）")
        if errs:
            bad = 1
            print(f"  FAIL {m['fixture']}: " + "; ".join(errs[:6]) + (f" ほか {len(errs) - 6}" if len(errs) > 6 else ""))
        elif cmd == "check":
            kb = sum(len(b) for b in tree(root).values()) // 1024
            print(f"  ok   {m['fixture']}: {m['repo']}@{m['base'][:7]} の写し（{kb} KB）・上流の手がかりなし")
    return bad


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
