#!/bin/bash
# E1b の評価一式を、モデルを呼ばずに確かめる（tools/selftest.sh の最後からも呼ばれる）。
#   1. 隠しテスト: 変更なし=落ちる、不具合入り（元の fix の直前のコード + 罠以外の作業は正しく済ませたもの）=罠の項目だけ落ちる、修正済み=通る
#   2. チェックリスト: 罠の diff（不具合入り・修正済みとも）で狙いの項目が発火する
#   3. 見える側のテストが、fixture のまま・参照解を当てたあとの両方で通る
#   4. fixture が元のリポジトリの pinned SHA の写しである（tools/e1b-provenance.py）。チェックリストが全 fixture で同じ、P1 の CLAUDE.md と一致
#   5. fixture に node --test が拾う JS がない（CI はリポジトリ全体で node --test を走らせる）、大きさが 400 KB 以下
# 使い方: tools/selftest-e1b.sh [TASK...]   （終了コード 0 = すべて期待どおり）
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
py="${PYTHON:-python3}"
fail=0
ok()  { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fail=1; }

meta() {  # meta TASK ATTR -> checks/e1b/<task>.py の属性（FIXTURE、ITEM）
  "$py" -B -c 'import importlib.util,sys
s=importlib.util.spec_from_file_location("m",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(getattr(m,sys.argv[2]))' "$here/checks/e1b/${1//-/_}.py" "$2"
}
build() {  # build TASK VARIANT -> 作業ツリー（VARIANT: none|buggy|fixed）。変更は未コミット
  local d; d="$(mktemp -d)"
  cp -a "$here/fixtures-e1b/$(meta "$1" FIXTURE)/." "$d/"
  "$here/profiles/common/seed-git.sh" "$d" || exit 9
  [ "$2" != none ] && cp -a "$here/reference-e1b/$1/$2/." "$d/"
  echo "$d"
}
hidden() { (cd "$1" && TRIAL_WORKDIR="$1" "$py" -B "$here/checks/hidden_e1b.py" "$2" 2>&1 | tail -1); }
visible() { (cd "$1" && timeout 120 "$py" -B -m unittest discover -s tests >/dev/null 2>&1); }

tasks=("$@")
[ ${#tasks[@]} -eq 0 ] && for f in "$here"/tasks-e1b/*.yaml; do tasks+=("$(basename "$f" .yaml)"); done
for task in "${tasks[@]}"; do
  echo "== E1b $task"
  item="$(meta "$task" ITEM)"
  d="$(build "$task" none)"
  visible "$d" && ok "見える側のテストが通る（fixture のまま）" || bad "見える側のテストが落ちる（fixture のまま）"
  r="$(hidden "$d" "$task")"; case "$r" in FAIL*) ok "変更なし → 落ちる";; *) bad "変更なしで通った: $r";; esac
  variants="fixed"; [[ $task == trap-* ]] && variants="buggy fixed"
  for v in $variants; do
    d="$(build "$task" "$v")"
    if [[ $task == trap-* ]]; then
      f="$("$here/tools/fired.sh" "$d")"
      [[ " $f " == *" $item "* ]] && ok "$v: 発火 [$f]" || bad "$v: $item が発火しない（[$f]）"
    fi
    visible "$d" && ok "$v: 見える側のテストが通る" || bad "$v: 見える側のテストが落ちる"
    git -C "$d" add -A && git -C "$d" commit -q -m change
    r="$(hidden "$d" "$task")"
    if [ "$v" = buggy ]; then
      # 罠の項目だけが落ちること（罠以外の作業が原因で落ちているのではないこと）
      if [[ $r == FAIL* && $r == *"trap:"* && $r != *"sub:"* ]]; then ok "不具合入り → 罠の項目だけ落ちる（${r:0:160}）"
      else bad "不具合入りが期待どおりでない: ${r:0:300}"; fi
    else case "$r" in PASS*) ok "修正済み → 通る";; *) bad "修正済みで落ちた: ${r:0:300}";; esac; fi
  done
done

echo "== E1b の fixture"
"$py" -B "$here/tools/e1b-provenance.py" || bad "fixture が元のリポジトリの写しと食い違う"
base=""
for fx in "$here"/fixtures-e1b/*/; do
  n="$(basename "$fx")"; [[ $n == _* ]] && continue   # _items/ などは fixture ではない
  c="$fx.claude/verification/checklist.json"
  [ -f "$c" ] || { bad "$n: checklist.json がない"; continue; }
  [ -z "$base" ] && base="$c"
  cmp -s "$base" "$c" && ok "$n: チェックリストが共通のものと同じ" || bad "$n: checklist.json が違う"
  cmp -s "$fx.claude/skills/verify/SKILL.md" "$fx.agents/skills/verify/SKILL.md" && ok "$n: verify スキル（Claude・Codex）が同じ" || bad "$n: verify スキルが .claude と .agents で違う"
  js="$(find "$fx" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) | head -3)"
  [ -z "$js" ] && ok "$n: JS なし" || bad "$n: JS がある（CI の node --test が拾いうる）: $js"
  kb="$(du -sk "$fx" | cut -f1)"; [ "$kb" -le 400 ] && ok "$n: ${kb} KB" || bad "$n: ${kb} KB（400 KB を超える）"
done
[ -n "$base" ] && { "$py" "$here/tools/gen-static-rules.py" "$base" --check "$here/profiles-e1b/static-rules/CLAUDE.md" \
  && ok "P1（E1b）の CLAUDE.md が checklist.json と一致" || bad "P1（E1b）の CLAUDE.md が古い（tools/gen-static-rules.py で作り直す）"; }
[ $fail -eq 0 ] && echo "selftest-e1b: すべて期待どおり" || echo "selftest-e1b: 失敗あり"
exit $fail
