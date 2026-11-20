#!/bin/bash
# 解答エージェント（claude / codex）を bubblewrap の中で動かす。見えるのは試行ディレクトリ（一時ホームと作業ツリー）と、
# 動かすのに要る読み取り専用のシステムだけ。評価の中身（eval/checks・reference・tasks・fixtures・他の試行・trials.jsonl）、
# /workspace の残り、本物のホーム（gh の認証・~/.codex など）、/tmp の残りは見えない。ネットワークはモデルの API のために残す
# （上流リポジトリへの参照は leak_check.py が INVALID にする）。
#
# 使い方（プロファイルの executable の先頭に置く）: sandbox-run.sh REAL_CLI [ARGS...]
#   試行ディレクトリ = $HOME の親（AHE の isolate_home: HOME=<trial>/home）。VL_SANDBOX_RO に「:」区切りで、読み取り専用で
#   見せる追加のパス（層の hook が呼ぶ scripts/ など）を渡せる。VL_SANDBOX=off で素通し（比較・障害の切り分け用。結果は無効扱い）。
set -euo pipefail
[ $# -ge 1 ] || { echo "使い方: sandbox-run.sh REAL_CLI [ARGS...]" >&2; exit 2; }
if [ "${VL_SANDBOX:-on}" = off ]; then exec "$@"; fi
command -v bwrap >/dev/null || { echo "sandbox-run: bwrap がありません（apt install bubblewrap）" >&2; exit 2; }
trial="$(cd "$HOME/.." && pwd -P)"
case "$trial" in /|/home|/home/*/|"$(cd ~root 2>/dev/null && pwd || echo /root)") echo "sandbox-run: HOME が試行の一時ホームではありません: $HOME" >&2; exit 2;; esac
[ -d "$trial/workdir" ] || { echo "sandbox-run: $trial/workdir がありません（AHE の試行ディレクトリで呼ぶ）" >&2; exit 2; }
orig="$(command -v "$1")"; real="$(readlink -f "$orig")"; shift
# 実行するパス: 本物のホームの下（~/.local/bin のリンクなど）は中から見えないので実体を使う。それ以外は元のパス
# （venv の python は、リンクをたどると venv の外の python になり site-packages を失うため）
run="$orig"; case "$orig" in /home/*|/root/*) run="$real";; esac
args=(--die-with-parent --unshare-pid --unshare-ipc --unshare-uts --share-net
      --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run --tmpfs /home --tmpfs /workspace)
for p in /usr /bin /sbin /lib /lib32 /lib64 /etc /opt /usr/local; do [ -e "$p" ] && args+=(--ro-bind "$p" "$p"); done
# CLI の本体（node_modules。秘密は置かれない）。本物のホームの他の場所は見せない
case "$real" in
  */node_modules/*) nm="${real%%/node_modules/*}/node_modules"; args+=(--ro-bind "$nm" "$nm");;
  *) args+=(--ro-bind "$real" "$real");;
esac
IFS=: read -r -a extra <<< "${VL_SANDBOX_RO:-}"
for p in "${extra[@]}"; do [ -n "$p" ] && [ -e "$p" ] && args+=(--ro-bind "$p" "$p"); done
args+=(--bind "$trial" "$trial" --chdir "$PWD" --setenv TMPDIR /tmp --unsetenv GH_TOKEN --unsetenv GITHUB_TOKEN --unsetenv GH_CONFIG_DIR)
exec bwrap "${args[@]}" -- "$run" "$@"
