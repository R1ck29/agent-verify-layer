#!/bin/sh
# held-out の P0（素のベースライン）だけで使う install の手順: fixture の複製から v0.1 の層の部品（verify スキル・チェックリスト）を外す。
# seed-git.sh より前に呼ぶ（外した状態で 1 コミットにする）。run-eval.sh が heldout の P0 のプロファイルにこの手順を差し込む。
# 使い方: strip-layer.sh WORKDIR
set -eu
dir="${1:?usage: strip-layer.sh WORKDIR}"
cd "$dir"
[ -e .git ] && { echo "strip-layer: $dir は既に git リポジトリ（seed-git.sh より前に呼ぶ）" >&2; exit 1; }
rm -rf .claude/skills/verify .agents/skills/verify .claude/verification
for d in .claude/skills .agents/skills .claude .agents; do [ -d "$d" ] && rmdir "$d" 2>/dev/null || true; done
exit 0
