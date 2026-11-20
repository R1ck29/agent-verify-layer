#!/bin/bash
# held-out の評価一式を、モデルを呼ばずに確かめる（決定的）。
#   1. 隠しテスト: 変更なしの fixture = 落ちる、参照解（fixed）= 通る、ありがちな浅い直し（naive。罠だけ）= 罠の項目だけ落ちる
#   2. 見える側のテスト: fixture のまま・参照解を当てたあとで通る（naive のときの結果は参考として出す）
#   3. fixture が上流の base の写しで、上流の手がかり（URL・修正の SHA）・.git・カナリアを含まない（tools/build_fixtures.py check）
#   4. 隠しテスト・参照解のすべてのファイルにカナリアがある。fixture・参照解のファイルはすべて git に入っている
#   4b. 採点の入口: 追加テストファイルを除いた新しいコピーで、隠しテストと元の公開テストをパス明示で動かす（tools/test_grading.py）
#   5. P0 の手順（tools/strip-layer.sh）で層の部品が消える。fixture は 600 KB 以下
# 使い方: heldout/selftest.sh [TASK...]   （終了コード 0 = すべて期待どおり）
set -u
here="$(cd "$(dirname "$0")" && pwd)"
eval_dir="$(cd "$here/.." && pwd)"
py="${PYTHON:-python3}"
fail=0
ok()  { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fail=1; }

fixture_of() { sed -n 's#^fixture: \.\./fixtures/##p' "$here/tasks/$1.yaml"; }
build() {  # build TASK VARIANT -> 作業ツリー（none|fixed|naive）。変更は未コミット
  local d; d="$(mktemp -d)"
  cp -a "$here/fixtures/$(fixture_of "$1")/." "$d/"
  sh "$eval_dir/profiles/common/seed-git.sh" "$d" || exit 9
  [ "$2" != none ] && cp -a "$here/reference/$1/$2/." "$d/"
  echo "$d"
}
visible() {  # fixture の形に合わせて見える側のテストを動かす
  (cd "$1" && if [ -d src ]; then PYTHONPATH=src timeout 600 "$py" -B -m unittest discover -s tests -t . >/dev/null 2>&1
   elif [ -f test_schedule.py ]; then timeout 600 "$py" -B -m unittest discover -s . -p 'test*.py' >/dev/null 2>&1
   else timeout 600 "$py" -B -m unittest discover -s tests -t . >/dev/null 2>&1; fi)
}
hidden() { (cd "$1" && TRIAL_WORKDIR="$1" "$py" -B "$here/checks/hidden_heldout.py" "$2" 2>&1 | tail -1); }
commit() { git -C "$1" add -A && git -C "$1" commit -q -m change; }

tasks=("$@")
[ ${#tasks[@]} -eq 0 ] && for f in "$here"/tasks/*.yaml; do tasks+=("$(basename "$f" .yaml)"); done
for task in "${tasks[@]}"; do
  echo "== held-out $task（$(fixture_of "$task")）"
  d="$(build "$task" none)"
  visible "$d" && ok "見える側のテストが通る（fixture のまま）" || bad "見える側のテストが落ちる（fixture のまま）"
  r="$(hidden "$d" "$task")"; case "$r" in FAIL*) ok "変更なし → 落ちる";; *) bad "変更なしで通った: $r";; esac
  d="$(build "$task" fixed)"
  visible "$d" && ok "参照解: 見える側のテストが通る" || bad "参照解: 見える側のテストが落ちる"
  commit "$d"; r="$(hidden "$d" "$task")"
  case "$r" in PASS*) ok "参照解 → 通る";; *) bad "参照解で落ちた: ${r:0:300}";; esac
  if [[ $task == trap-* ]]; then
    [ -d "$here/reference/$task/naive" ] || { bad "浅い直し（reference/$task/naive）がない"; continue; }
    d="$(build "$task" naive)"
    if visible "$d"; then ok "浅い直し: 見える側のテストは通る"; else echo "  info 浅い直し: 見える側の既存のテストでも落ちる（全体のテストを走らせれば気づける罠）"; fi
    commit "$d"; r="$(hidden "$d" "$task")"
    if [[ $r == FAIL* && $r == *"trap:"* && $r != *"sub:"* ]]; then ok "浅い直し → 罠の項目だけ落ちる（${r:0:150}）"
    else bad "浅い直しが期待どおりでない: ${r:0:300}"; fi
  fi
done

echo "== 採点の入口（追加テストを取り除いた新しいコピー・公開テストをパス明示で）"
"$py" -B "$here/tools/test_grading.py" >/dev/null 2>&1 && ok "追加テスト（同名 basename・import 時の副作用）は結果を変えない／公開テストが落ちれば不合格／seed のない履歴は採点しない" || bad "tools/test_grading.py が落ちる"

echo "== held-out の fixture・参照解"
"$py" -B "$here/tools/build_fixtures.py" check || bad "fixture が上流の写しと食い違う・上流の手がかりがある"
nocan="$(find "$here/checks" "$here/reference" -type f ! -path '*/manifests/*' ! -name '*.pyc' -exec grep -L "VL-EVAL-CANARY-7f3c1a" {} + | head -5)"
[ -z "$nocan" ] && ok "隠しテスト・参照解のファイルにカナリアがある" || bad "カナリアがない: $nocan"
leak="$(grep -rl -e "VL-EVAL-CANARY" -e "hidden_heldout" "$here/fixtures" 2>/dev/null | head -3)"
[ -z "$leak" ] && ok "fixture に隠しテスト・参照解の印がない" || bad "fixture に評価の印: $leak"
untracked="$(git -C "$here" ls-files --others --ignored --exclude-standard -- fixtures reference checks tasks | grep -v -e __pycache__ -e '\.pyc$' | head -5)"
[ -z "$untracked" ] && ok "fixture・参照解・隠しテストはすべて git に入っている" || bad "git に入っていないファイル（git add -f する）: $untracked"
for fx in "$here"/fixtures/*/; do
  n="$(basename "$fx")"; d="$(mktemp -d)"; cp -a "$fx." "$d/"
  sh "$here/tools/strip-layer.sh" "$d" && sh "$eval_dir/profiles/common/seed-git.sh" "$d"
  left="$(git -C "$d" ls-files | grep -e '^\.claude/' -e '^\.agents/' | head -3)"
  [ -z "$left" ] && ok "$n: P0 の手順で層の部品が消える" || bad "$n: P0 で残る: $left"
  kb="$(du -sk --apparent-size --exclude=__pycache__ "$fx" | cut -f1)"; [ "$kb" -le 600 ] && ok "$n: ${kb} KB" || bad "$n: ${kb} KB（600 KB を超える）"
done
[ $fail -eq 0 ] && echo "selftest-heldout: すべて期待どおり" || echo "selftest-heldout: 失敗あり"
exit $fail
