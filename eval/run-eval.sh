#!/bin/bash
# agent-verify-layer の評価（Claude 側） E1（縮小版）の実行。
#   ./run-eval.sh smoke   1 罠タスク × 3 プロファイル × 1 回 = 3 試行
#   ./run-eval.sh full    8 タスク × 3 プロファイル × 2 回 = 48 試行
#   ./run-eval.sh dry     模擬 CLI でパイプライン全体を通す（モデルを呼ばない・認証不要）。結果は捨てる
# smoke / full は、ログイン済みの外側のシェルで、CLAUDE_CODE_OAUTH_TOKEN（claude setup-token で作る）を export してから実行する。
# トークンの値は、どこにも書かない・表示しない（名前の有無だけ確かめる）。
# 出力: ../../eval-out/<smoke|full>（OUT_ROOT で変更可）。AHE の場所: ../../agent-harness-eval（AHE_DIR で変更可）。
set -euo pipefail
mode="${1:-}"
case "$mode" in smoke|full|dry) ;; *) echo "使い方: $0 smoke|full|dry" >&2; exit 2;; esac

here="$(cd "$(dirname "$0")" && pwd)"
AHE_DIR="$(cd "${AHE_DIR:-$here/../../agent-harness-eval}" && pwd)"
OUT_ROOT="${OUT_ROOT:-$here/../../eval-out}"
PY="$AHE_DIR/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
export PYTHONPATH="$AHE_DIR${PYTHONPATH:+:$PYTHONPATH}"
for c in node git; do command -v "$c" >/dev/null || { echo "$c が見つかりません" >&2; exit 2; }; done

he() { "$PY" -m harness_eval "$@"; }
profiles="$here/profiles/claude-*.yaml"
tasks="$here/tasks"

if [ "$mode" = dry ]; then
  out="$(mktemp -d)"
  prof="$out/profiles"; mkdir -p "$prof"
  for f in "$here"/profiles/claude-*.yaml; do   # 認証を外し、模擬 CLI を使う。ほかは本物のプロファイルと同じ
    sed -e "s#{profile_dir}#$here/profiles#g" -e "s#copy: static-rules#copy: $here/profiles/static-rules#" \
        -e '/^inherit_env:/d' -e '/^billing:/d' -e '/^hash_paths:/d' "$f" > "$prof/$(basename "$f")"
    printf 'executable: ["%s", "%s"]\n' "$PY" "$here/tools/fake_claude.py" >> "$prof/$(basename "$f")"
  done
  profiles="$prof/claude-*.yaml"
  export FAKE_VERIFY=1
  trials=1; extra=(--tag verify-layer)
else
  : "${CLAUDE_CODE_OAUTH_TOKEN:?CLAUDE_CODE_OAUTH_TOKEN が未設定です。外側のシェルで claude setup-token → export してください（値は表示しません）}"
  out="$OUT_ROOT/$mode"; mkdir -p "$out"
  if [ "$mode" = smoke ]; then trials=1; extra=(--tag smoke); else trials=2; extra=(--tag verify-layer); fi
fi

# キャッシュは使わない（隠しテストなどタスク YAML の外にある採点の変更が、キャッシュのキーに入らないため）。作業の場所も出力先にする
cd "$out"
cache=(--no-cache --cache-dir "$out/.harness-eval-cache")
echo "== 定義の検証（モデルを呼ばない）"
he validate --tasks "$tasks" --profiles "$profiles"
if [ "$mode" != dry ]; then
  echo "== 環境の静的確認（doctor。--live は付けない = モデルを呼ばない。NG なら止める）"
  he doctor --profiles "$profiles" --out "$out"
fi
echo "== 見積もり（モデルを呼ばない）"
he plan --tasks "$tasks" --profiles "$profiles" "${extra[@]}" --trials "$trials" --no-llm --baseline claude-baseline --jobs 2 --max-cost-usd 30 "${cache[@]}" --out "$out"
echo "== 実行 → $out"
he run --tasks "$tasks" --profiles "$profiles" "${extra[@]}" --trials "$trials" --no-llm --baseline claude-baseline \
  --jobs 2 --max-cost-usd 30 --keep all "${cache[@]}" --out "$out"
echo "== 完了: $out（作業ツリーと台帳は各試行の workdir に残してあります。集計は次のセッションで）"
[ "$mode" = dry ] && echo "dry の出力先: $out"
