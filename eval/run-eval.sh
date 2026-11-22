#!/bin/bash
# agent-verify-layer の評価（Claude 側）の実行。
#   ./run-eval.sh MODE [SUITE]      SUITE: e1（既定。E1 縮小版）| e1b（実リポジトリの罠。README の「E1b」）
#   ./run-eval.sh smoke             E1: 1 罠タスク × 3 プロファイル × 1 回 = 3 試行
#   ./run-eval.sh full              E1: 8 タスク × 3 プロファイル × 2 回 = 48 試行
#   ./run-eval.sh smoke e1b         E1b: 1 罠タスク（E1B_SMOKE_TASK）× 3 プロファイル × 1 回 = 3 試行
#   ./run-eval.sh smoke-p0          E1b: 罠すべて × P0（ベースライン）だけ × 1 回（安い天井の確認。SUITE は e1b に固定）
#   ./run-eval.sh full e1b          E1b: 罠すべて + E1 の対照 4 件 × 3 プロファイル × 2 回
#   ./run-eval.sh dry [SUITE]       模擬 CLI でパイプライン全体を通す（モデルを呼ばない・認証不要）。結果は捨てる
#   ./run-eval.sh plan [SUITE]      full と同じ定義で、検証・doctor・費用の見積もりまでで止まる（モデルを呼ばない。本番の前の確認）
#   ./run-eval.sh smoke-p0 heldout  held-out: 罠すべて × P0 だけ × 1 回（天井の確認。eval/heldout/README.md）。TRIALS=2 で較正スモーク（追補 B-0）
#   ./run-eval.sh full heldout      held-out: 罠 6 + 対照 3 × 3 プロファイル × TRIALS（決定的な評価は TRIALS=3。PREREG-v02.md）
#   SUITE=heldout の P0 は、fixture から v0.1 の層の部品（verify スキル・チェックリスト）を外して始める（heldout/tools/strip-layer.sh）
# smoke / smoke-p0 / full は、ログイン済みの外側のシェルで、CLAUDE_CODE_OAUTH_TOKEN（claude setup-token で作る）を export してから実行する。
# トークンの値は、どこにも書かない・表示しない（名前の有無だけ確かめる）。
# AHE は v0.10.0 以上（Linux の本物の実行は AHE の sandbox: bwrap で解答を隔離し、層の hook が呼ぶ scripts/・hooks/・codex/・rules/ は sandbox_ro で渡す。
# bwrap が使えなければ止まる。SANDBOX=off は切り分け用で、出力先に NOT-FOR-VERDICT.txt を置く = 結果は判定に使わない）。
# 出力: ../../eval-out/<mode>（E1b は <mode>-e1b。OUT_ROOT で変更可）。AHE の場所: ../../agent-harness-eval（AHE_DIR で変更可）。
set -euo pipefail
mode="${1:-}"
suite="${2:-${SUITE:-e1}}"
plan_only=0; outmode="$mode"
[ "$mode" = plan ] && { plan_only=1; mode=full; }
case "$mode" in smoke|full|dry) ;; smoke-p0) [ "${2:-}" = heldout ] && suite=heldout || suite=e1b;; *) echo "使い方: $0 smoke|full|dry|plan [e1|e1b|heldout]  または  $0 smoke-p0 [heldout]" >&2; exit 2;; esac
case "$suite" in e1|e1b|heldout) ;; *) echo "SUITE は e1・e1b・heldout のどれかです: $suite" >&2; exit 2;; esac

here="$(cd "$(dirname "$0")" && pwd)"
AHE_DIR="$(cd "${AHE_DIR:-$here/../../agent-harness-eval}" && pwd)"
OUT_ROOT="${OUT_ROOT:-$here/../../eval-out}"
PY="$AHE_DIR/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
export PYTHONPATH="$AHE_DIR${PYTHONPATH:+:$PYTHONPATH}"
ahe_ver="$("$PY" -c 'import harness_eval; print(harness_eval.__version__)' 2>/dev/null)" || { echo "AHE を読み込めません: $AHE_DIR（AHE_DIR で場所を指定。PyYAML が要ります）" >&2; exit 2; }
[ "$(printf '%s\n0.10.0\n' "$ahe_ver" | sort -V | head -n1)" = 0.10.0 ] || { echo "AHE は 0.10.0 以上が要ります（${ahe_ver}: $AHE_DIR）。解答の隔離・採点の隔離・ズル検査・環境変数の許可リストが v0.10.0 から入ったためです" >&2; exit 2; }
for c in node git; do command -v "$c" >/dev/null || { echo "$c が見つかりません" >&2; exit 2; }; done

he() { "$PY" -m harness_eval "$@"; }
if [ "$suite" = e1 ]; then
  pdir="$here/profiles"; tasks=("$here/tasks"); smoke_sel=(--tag smoke); tag=""
elif [ "$suite" = heldout ]; then  # held-out の罠と対照（eval/heldout/tasks）。プロファイルは E1b のもの
  pdir="$here/profiles-e1b"; tasks=("$here/heldout/tasks")
  smoke_sel=(--task "${HELDOUT_SMOKE_TASK:-trap-cache-iter-update}"); tag="-heldout"
else  # E1b の罠（tasks-e1b）と、後退の検出用に E1 の対照 4 件をそのまま
  pdir="$here/profiles-e1b"; tasks=("$here/tasks-e1b" "$here"/tasks/ctrl-*.yaml)
  smoke_sel=(--task "${E1B_SMOKE_TASK:-trap-csv-roundtrip}"); tag="-e1b"
fi
# AGENT=codex で Codex 側（profiles-e1b-codex。E1b のみ）。認証は ~/.codex/auth.json の複製（copy_credentials）
AGENT="${AGENT:-claude}"; base=claude-baseline
if [ "$AGENT" = codex ]; then
  [ "$suite" = e1 ] && { echo "AGENT=codex は e1b と heldout だけです" >&2; exit 2; }
  pdir="$here/profiles-e1b-codex"; base=codex-baseline; tag="$tag-codex"
fi
profiles=("$pdir"/$AGENT-*.yaml)
[ "$mode" = smoke-p0 ] && profiles=("$pdir/$base.yaml")
# held-out の P0 = 素のベースライン: 同じプロファイルの install の先頭に、層の部品を外す手順を差し込んだ版（同じディレクトリの隠しファイル。.gitignore 済み）
if [ "$suite" = heldout ]; then
  for i in "${!profiles[@]}"; do
    f="${profiles[$i]}"; [ "$(basename "$f" .yaml)" = "$base" ] || continue
    g="$(dirname "$f")/.p0.$(basename "$f")"
    awk '{print} /^install:/{print "  - run: '"'"'sh {profile_dir}/../heldout/tools/strip-layer.sh {workdir}'"'"'     # held-out の P0: v0.1 の層の部品を外す"}' "$f" > "$g"
    profiles[$i]="$g"
  done
fi

# P2=v02: PREREG-v02 の 3 プロファイル（P0 = 層なし、P1 = v0.1 の層、P2 = v0.2）にする。claude-static-rules は走らせない。
# v0.2 は VL_V02_DIR（feat/v0.2 の checkout）から入れる。実装（設定の verifyV2）がまだなければ止める。Codex は AHE の credentials: linked 対応待ち
V02_DIR=""
if [ "${P2:-}" = v02 ]; then
  { [ "$suite" = heldout ] && [ "$AGENT" = claude ]; } || { echo "P2=v02 は heldout の Claude だけです（Codex は AHE の credentials: linked 対応待ち。profiles-heldout/codex-verify-v02.yaml.disabled）" >&2; exit 2; }
  V02_DIR="$(cd "${VL_V02_DIR:-$here/../../vl-v02}" 2>/dev/null && pwd)" || { echo "VL_V02_DIR（v0.2 の checkout）が見つかりません" >&2; exit 2; }
  grep -qs verifyV2 "$V02_DIR/scripts/lib/config.js" || { echo "v0.2 の実装が $V02_DIR にまだありません（scripts/lib/config.js に verifyV2 の設定がない）。P2=v02 は実装のあとに" >&2; exit 2; }
  v02="$here/profiles-heldout/.v02.claude-verify-v02.yaml"
  sed "s#@V02_DIR@#$V02_DIR#g" "$here/profiles-heldout/claude-verify-v02.yaml" > "$v02"
  keep=()
  for f in "${profiles[@]}"; do case "$(basename "$f")" in *static-rules*) ;; *) keep+=("$f");; esac; done
  [ "$mode" = smoke-p0 ] || profiles=("${keep[@]}" "$v02")
fi

repo="$(cd "$here/.." && pwd)"
# 解答の隔離は AHE の sandbox: bwrap（Linux の既定）。見えるのは試行の一時ホーム・作業ツリーと読み取り専用のシステム・CLI 本体だけで、評価の中身・
# 他の試行・/workspace の残り・本物のホームは見えない。層の hook が呼ぶ scripts/・hooks/・codex/・rules/ は sandbox_ro（読み取り専用）で渡す。
# tools/sandbox-run.sh は使わない（executable に挟むと bwrap が入れ子になり、/workspace の下のスクリプトも見えない）。
ro_paths=("$repo/scripts" "$repo/hooks" "$repo/codex" "$repo/rules")
sandbox_lines() {  # $1 = on|off、$2... = sandbox_ro のパス → プロファイルに足す行
  local m="$1"; shift
  if [ "$m" = off ]; then printf '\nsandbox: off     # run-eval.sh: SANDBOX=off（切り分け用。結果は判定に使わない）\n'; return; fi
  local l="" p; for p in "$@"; do [ -e "$p" ] && l="$l${l:+, }\"$p\""; done
  printf '\nsandbox: bwrap\nsandbox_ro: [%s]\n' "$l"
}
require_bwrap() {
  local why; why="$("$PY" -c 'from harness_eval.isolation import bwrap_problem; print(bwrap_problem() or "")' 2>&1)" || why="bwrap の確認に失敗: $why"
  [ -z "$why" ] || { echo "$why。隔離なしで決定的な評価は走らせません（SANDBOX=off は切り分け用で、結果は判定に使わない）" >&2; exit 2; }
}

if [ "$mode" = dry ]; then
  out="$(mktemp -d)"
  prof="$out/profiles"; mkdir -p "$prof"
  for f in "${profiles[@]}"; do   # 認証を外し、模擬 CLI を使う。ほかは本物のプロファイルと同じ（held-out の P0 は層を外した版）
    n="$(basename "$f")"; n="${n#.p0.}"; n="${n#.v02.}"
    sed -e "s#{profile_dir}#$(dirname "$f")#g" -e "s#copy: static-rules#copy: $pdir/static-rules#" \
        -e '/^inherit_env:/d' -e '/^billing:/d' -e '/^hash_paths:/d' "$f" > "$prof/$n"
    if [ "${SANDBOX:-}" = dry ]; then  # 隔離の通し確認: 模擬 CLI も AHE の bwrap の中で動かす（参照解は見えない）。venv の Python はリンクの道筋が隔離の中で切れるのでシステムの python3
      printf 'executable: ["%s", "%s"]\n' "$(command -v python3)" "$here/tools/fake_claude.py" >> "$prof/$n"
      sandbox_lines on "${ro_paths[@]}" >> "$prof/$n"
    else
      printf 'executable: ["%s", "%s"]\n' "$PY" "$here/tools/fake_claude.py" >> "$prof/$n"  # 模擬 CLI は参照解を作業ツリーに当てるので、隔離は切る（結果は捨てる）
      sandbox_lines off >> "$prof/$n"
    fi
  done
  profiles=("$prof"/claude-*.yaml)
  # 試行の環境変数は AHE の許可リスト（inherit_env に名前を書いたものだけ）。模擬 CLI の挙動を決める変数を渡す
  export FAKE_VERIFY=1 FAKE_COST="${FAKE_COST:-0}" FAKE_VARIANT="${FAKE_VARIANT:-fixed}" FAKE_PEEK=0
  [ "${SANDBOX:-}" = dry ] && { require_bwrap; export FAKE_PEEK=1; }  # 参照解を読みに行く模擬エージェント
  for f in "${profiles[@]}"; do printf 'inherit_env: [FAKE_VERIFY, FAKE_COST, FAKE_VARIANT, FAKE_PEEK]\n' >> "$f"; done
  trials=1; extra=(--tag verify-layer)
else
  [ "$AGENT" = codex ] || : "${CLAUDE_CODE_OAUTH_TOKEN:?CLAUDE_CODE_OAUTH_TOKEN が未設定です。外側のシェルで claude setup-token → export してください（値は表示しません）}"
  out="$OUT_ROOT/$outmode$tag"; mkdir -p "$out"
  case "$mode" in
    smoke) trials=1; extra=("${smoke_sel[@]}");;
    smoke-p0) trials="${TRIALS:-1}"; extra=(--tag e1b); [ "$suite" = heldout ] && extra=(--tag heldout-trap);;  # 罠だけ（対照は含めない）
    full) trials="${TRIALS:-2}"; [ "$suite" = heldout ] && trials="${TRIALS:-3}"; extra=(--tag verify-layer);;  # held-out の決定的な評価は 3 試行（PREREG-v02）
  esac
  # 隔離版のプロファイルは元と同じディレクトリに隠しファイルで作る（相対パスの install・hash_paths をそのまま使うため。.gitignore 済み）
  if [ "${SANDBOX:-on}" = off ]; then
    sbx=off
    printf '%s\n' "SANDBOX=off で実行した。解答を隔離していない。この出力は判定に使わない（切り分け用）。" > "$out/NOT-FOR-VERDICT.txt"
    echo "!! SANDBOX=off: 解答を隔離しません。結果は判定に使えません（$out/NOT-FOR-VERDICT.txt）" >&2
  else
    sbx=on; require_bwrap
  fi
  sp=()
  for f in "${profiles[@]}"; do
    g="$(dirname "$f")/.sbx.$(basename "$f")"
    extra_ro=(); case "$(basename "$f")" in .v02.*) extra_ro=("$V02_DIR/scripts" "$V02_DIR/hooks" "$V02_DIR/codex" "$V02_DIR/rules" "$V02_DIR/skills");; esac  # v0.2 の hook・スキルの置き場
    { cat "$f"; sandbox_lines "$sbx" "${ro_paths[@]}" "${extra_ro[@]}"; } > "$g"
    sp+=("$g")
  done
  profiles=("${sp[@]}")
  [ "$sbx" = on ] && echo "== 解答の隔離: AHE の sandbox: bwrap（sandbox_ro: scripts・hooks・codex・rules）"
fi
# 実行全体の費用の上限（推定額）。E1 は従来どおり 30。E1b は smoke 5・smoke-p0 10・full 30。held-out の full は PREREG-v02 の解く側の上限（Claude 16・Codex 10。判定は副次で別）
cap=30
if [ "$suite" != e1 ]; then case "$mode" in smoke) cap=5;; smoke-p0) cap=10;; esac; fi
if [ "$suite" = heldout ] && [ "$mode" = full ]; then cap=16; [ "$AGENT" = codex ] && cap=10; fi
cap="${CAP_USD:-$cap}"

# キャッシュは使わない（隠しテストなどタスク YAML の外にある採点の変更が、キャッシュのキーに入らないため）。作業の場所も出力先にする
cd "$out"
cache=(--no-cache --cache-dir "$out/.harness-eval-cache")
echo "== 定義の検証（モデルを呼ばない）"
he validate --tasks "${tasks[@]}" --profiles "${profiles[@]}"
if [ "$mode" != dry ]; then
  echo "== 環境の静的確認（doctor。--live は付けない = モデルを呼ばない。NG なら止める）"
  he doctor --profiles "${profiles[@]}" --out "$out"
fi
if [ "$suite" = heldout ] || [ "$mode" = dry ]; then
  # AHE v0.10.0 は履歴（cache-dir の記録）がない呼び出しをタスクの max_budget_usd（1.5）で数え、81 試行 = 121.5 USD で上限を超えて止まる。
  # E1b の実測から履歴専用の記録を置く（hist-*.json。キャッシュのキーではないので結果は再利用されない。--no-cache は維持）。dry は費用 0 の偽 CLI なので 0 円
  # HIST_JSONL=none で履歴を置かない（履歴なしだと上限で止まることの確認用）。HIST_JSONL=PATH で E1b の実測の場所を変える
  hist=(--agent "$AGENT"); [ "$mode" = dry ] && hist+=(--zero); [ -n "${HIST_JSONL:-}" ] && hist+=(--from-jsonl "$HIST_JSONL")
  [ "${HIST_JSONL:-}" = none ] || "$PY" "$here/tools/make-cost-history.py" --out "$out/.harness-eval-cache" "${hist[@]}"
fi
echo "== 見積もり（モデルを呼ばない。上限 \$$cap）"
planlog="$out/plan.log"
he plan --tasks "${tasks[@]}" --profiles "${profiles[@]}" "${extra[@]}" --trials "$trials" --no-llm --baseline "$base" --jobs "${JOBS:-2}" --max-cost-usd "$cap" "${cache[@]}" --out "$out" | tee "$planlog"
if [ "$plan_only" = 1 ]; then
  # he plan は上限を判定しない（止めるのは he run）。plan モードは run が止まるかどうかを先に知る用なので、同じ判定をここで行う
  est="$(sed -n 's/^  解く側（solver）の概算: \$\([0-9.]*\).*/\1/p' "$planlog" | head -n1)"
  if awk -v e="${est:-0}" -v c="$cap" 'BEGIN { exit !(e + 0 > c + 0) }'; then
    echo "止めました: 見積もり \$$est が --max-cost-usd \$$cap を超えます（run もここで止まります。何も実行していません）" >&2
    exit 2
  fi
  echo "== plan: ここまで（モデルは呼んでいません。見積もり \$$est ≤ 上限 \$$cap）→ $out"
  exit 0
fi
echo "== 実行 → $out"
he run --tasks "${tasks[@]}" --profiles "${profiles[@]}" "${extra[@]}" --trials "$trials" --no-llm --baseline "$base" \
  --jobs "${JOBS:-2}" --max-cost-usd "$cap" --keep all "${cache[@]}" --out "$out"
echo "== 完了: $out（作業ツリーと台帳は各試行の workdir に残してあります。集計は次のセッションで）"
if [ "$mode" = dry ]; then echo "dry の出力先: $out"; fi
