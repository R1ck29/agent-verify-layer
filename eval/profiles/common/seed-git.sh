#!/bin/sh
# 全プロファイル共通の install 手順: 作業ディレクトリ（fixture の複製）を、1 コミットの git リポジトリにする。
# AHE のタスクには「git の準備」を書くキーがないため、fixture を複製したあとの install で行う（AHE 本体は変えない）。
# 同じ fixture からは、同じ内容のコミットができる（日時・作者を固定）。
# 使い方: seed-git.sh WORKDIR
set -eu
dir="${1:?usage: seed-git.sh WORKDIR}"
cd "$dir"
[ -e .git ] && { echo "seed-git: $dir は既に git リポジトリ" >&2; exit 1; }
# 一時ホームには git の設定がないので、リポジトリ側に作者を持たせる（エージェントのコミットにも使われる）
git init -q -b main
git config user.name "Eval Fixture"
git config user.email "fixture@example.invalid"
git config commit.gpgsign false
git add -A
GIT_AUTHOR_DATE="2026-01-01T00:00:00+0000" GIT_COMMITTER_DATE="2026-01-01T00:00:00+0000" \
  git commit -q -m "seed: initial fixture"
