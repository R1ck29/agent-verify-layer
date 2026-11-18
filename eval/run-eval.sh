#!/bin/bash
# agent-verify-layer の評価（Claude 側）の実行。
#   ./run-eval.sh MODE [SUITE]      SUITE: e1（既定。E1 縮小版）| e1b（実リポジトリの罠。README の「E1b」）
#   ./run-eval.sh smoke             E1: 1 罠タスク × 3 プロファイル × 1 回 = 3 試行
#   ./run-eval.sh full              E1: 8 タスク × 3 プロファイル × 2 回 = 48 試行
#   ./run-eval.sh smoke e1b         E1b: 1 罠タスク（E1B_SMOKE_TASK）× 3 プロファイル × 1 回 = 3 試行
#   ./run-eval.sh smoke-p0          E1b: 罠すべて × P0（ベースライン）だけ × 1 回（安い天井の確認。SUITE は e1b に固定）
#   ./run-eval.sh full e1b          E1b: 罠すべて + E1 の対照 4 件 × 3 プロファイル × 2 回
#   ./run-eval.sh dry [SUITE]       模擬 CLI でパイプライン全体を通す（モデルを呼ばない・認証不要）。結果は捨てる
# smoke / smoke-p0 / full は、ログイン済みの外側のシェルで、CLAUDE_CODE_OAUTH_TOKEN（claude setup-token で作る）を export してから実行する。
# トークンの値は、どこにも書かない・表示しない（名前の有無だけ確かめる）。
# 出力: ../../eval-out/<mode>（E1b は <mode>-e1b。OUT_ROOT で変更可）。AHE の場所: ../../agent-harness-eval（AHE_DIR で変更可）。
set -euo pipefail
mode="${1:-}"
suite="${2:-${SUITE:-e1}}"
case "$mode" in smoke|full|dry) ;; smoke-p0) suite=e1b;; *) echo "使い方: $0 smoke|full|dry [e1|e1b]  または  $0 smoke-p0" >&2; exit 2;; esac
case "$suite" in e1|e1b) ;; *) echo "SUITE は e1 か e1b です: $suite" >&2; exit 2;; esac

here="$(cd "$(dirname "$0")" && pwd)"
AHE_DIR="$(cd "${AHE_DIR:-$here/../../agent-harness-eval}" && pwd)"
OUT_ROOT="${OUT_ROOT:-$here/../../eval-out}"
PY="$AHE_DIR/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
export PYTHONPATH="$AHE_DIR${PYTHONPATH:+:$PYTHONPATH}"
for c in node git; do command -v "$c" >/dev/null || { echo "$c が見つかりません" >&2; exit 2; }; done

he() { "$PY" -m harness_eval "$@"; }
if [ "$suite" = e1 ]; then
  pdir="$here/profiles"; tasks=("$here/tasks"); smoke_sel=(--tag smoke); tag=""
else  # E1b の罠（tasks-e1b）と、後退の検出用に E1 の対照 4 件をそのまま
  pdir="$here/profiles-e1b"; tasks=("$here/tasks-e1b" "$here"/tasks/ctrl-*.yaml)
  smoke_sel=(--task "${E1B_SMOKE_TASK:-trap-csv-roundtrip}"); tag="-e1b"
fi
profiles=("$pdir"/claude-*.yaml)
[ "$mode" = smoke-p0 ] && profiles=("$pdir/claude-baseline.yaml")

if [ "$mode" = dry ]; then
  out="$(mktemp -d)"
  prof="$out/profiles"; mkdir -p "$prof"
  for f in "$pdir"/claude-*.yaml; do   # 認証を外し、模擬 CLI を使う。ほかは本物のプロファイルと同じ
    sed -e "s#{profile_dir}#$pdir#g" -e "s#copy: static-rules#copy: $pdir/static-rules#" \
        -e '/^inherit_env:/d' -e '/^billing:/d' -e '/^hash_paths:/d' "$f" > "$prof/$(basename "$f")"
    printf 'executable: ["%s", "%s"]\n' "$PY" "$here/tools/fake_claude.py" >> "$prof/$(basename "$f")"
  done
  profiles=("$prof"/claude-*.yaml)
  export FAKE_VERIFY=1
  trials=1; extra=(--tag verify-layer)
else
  : "${CLAUDE_CODE_OAUTH_TOKEN:?CLAUDE_CODE_OAUTH_TOKEN が未設定です。外側のシェルで claude setup-token → export してください（値は表示しません）}"
  out="$OUT_ROOT/$mode$tag"; mkdir -p "$out"
  case "$mode" in
    smoke) trials=1; extra=("${smoke_sel[@]}");;
    smoke-p0) trials=1; extra=(--tag e1b);;          # E1b の罠だけ（E1 の対照は含めない）
    full) trials=2; extra=(--tag verify-layer);;
  esac
fi
# 実行全体の費用の上限（推定額）。E1 は従来どおり 30。E1b は 1 試行の上限 1.5 USD（タスク YAML）に合わせて、smoke 5・smoke-p0 10・full 30
cap=30
if [ "$suite" = e1b ]; then case "$mode" in smoke) cap=5;; smoke-p0) cap=10;; esac; fi

# キャッシュは使わない（隠しテストなどタスク YAML の外にある採点の変更が、キャッシュのキーに入らないため）。作業の場所も出力先にする
cd "$out"
cache=(--no-cache --cache-dir "$out/.harness-eval-cache")
echo "== 定義の検証（モデルを呼ばない）"
he validate --tasks "${tasks[@]}" --profiles "${profiles[@]}"
if [ "$mode" != dry ]; then
  echo "== 環境の静的確認（doctor。--live は付けない = モデルを呼ばない。NG なら止める）"
  he doctor --profiles "${profiles[@]}" --out "$out"
fi
echo "== 見積もり（モデルを呼ばない）"
he plan --tasks "${tasks[@]}" --profiles "${profiles[@]}" "${extra[@]}" --trials "$trials" --no-llm --baseline claude-baseline --jobs 2 --max-cost-usd "$cap" "${cache[@]}" --out "$out"
echo "== 実行 → $out"
he run --tasks "${tasks[@]}" --profiles "${profiles[@]}" "${extra[@]}" --trials "$trials" --no-llm --baseline claude-baseline \
  --jobs 2 --max-cost-usd "$cap" --keep all "${cache[@]}" --out "$out"
echo "== 完了: $out（作業ツリーと台帳は各試行の workdir に残してあります。集計は次のセッションで）"
if [ "$mode" = dry ]; then echo "dry の出力先: $out"; fi
