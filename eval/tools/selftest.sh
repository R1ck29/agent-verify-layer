#!/bin/bash
# モデルを呼ばずに、評価一式を確かめる。
#   1. 隠しテスト: 変更なし=落ちる、不具合入り（罠）=落ちる、修正済み=通る
#   2. チェックリスト: 罠の diff（不具合入り・修正済みとも）で狙いの項目が発火し、対照の diff では何も発火しない
#   3. 4 つの fixture のチェックリストが同じ内容で、P1 の CLAUDE.md が checklist.json と一致している
#   4. E1b（tools/selftest-e1b.sh）
# 使い方: tools/selftest.sh   （終了コード 0 = すべて期待どおり）
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
py="${PYTHON:-python3}"
fail=0
ok()  { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fail=1; }

declare -A FX=(
  [trap-locale-decode]=snapkit [ctrl-format-size]=snapkit
  [trap-fifo-bounded-read]=taskstore [ctrl-oldest-open]=taskstore
  [trap-rejection-leak]=improver [ctrl-format-problems]=improver
  [trap-drift-scope]=hookinstall [ctrl-managed-events]=hookinstall
)
declare -A ITEM=(
  [trap-locale-decode]=subprocess-locale-decode [trap-fifo-bounded-read]=untrusted-file-bounded-read
  [trap-rejection-leak]=rejection-path-record [trap-drift-scope]=drift-compare-own-scope
)

build() {  # build TASK VARIANT -> 作業ツリーを作って、そのパスを出す（VARIANT: none|buggy|fixed）。変更は未コミット
  local task="$1" variant="$2" d
  d="$(mktemp -d)"
  cp -a "$here/fixtures/${FX[$task]}/." "$d/"
  "$here/profiles/common/seed-git.sh" "$d" || exit 9
  if [ "$variant" != none ]; then cp -a "$here/reference/$task/$variant/." "$d/"; fi
  echo "$d"
}
commit_all() { git -C "$1" add -A && git -C "$1" commit -q -m "change"; }
hidden() { (cd "$1" && TRIAL_WORKDIR="$1" "$py" "$here/checks/hidden.py" "$2" 2>&1 | tail -1); }

for task in "${!FX[@]}"; do
  echo "== $task"
  d="$(build "$task" none)"
  r="$(hidden "$d" "$task")"; case "$r" in FAIL*) ok "変更なし → 落ちる";; *) bad "変更なしで通った: $r";; esac
  variants="fixed"; [[ $task == trap-* ]] && variants="buggy fixed"
  for v in $variants; do
    d="$(build "$task" "$v")"
    f="$("$here/tools/fired.sh" "$d")"
    if [[ $task == trap-* ]]; then
      [[ " $f " == *" ${ITEM[$task]} "* ]] && ok "$v: 発火 [$f]" || bad "$v: ${ITEM[$task]} が発火しない（[$f]）"
    else
      [ -z "$f" ] && ok "$v: 何も発火しない" || bad "$v: 対照なのに発火 [$f]"
    fi
    commit_all "$d"
    r="$(hidden "$d" "$task")"
    if [ "$v" = buggy ]; then case "$r" in FAIL*) ok "不具合入り → 落ちる（$r）";; *) bad "不具合入りで通った: $r";; esac
    else case "$r" in PASS*) ok "修正済み → 通る";; *) bad "修正済みで落ちた: $r";; esac; fi
  done
done

echo "== checklist の同期"
base="$here/fixtures/snapkit/.claude/verification/checklist.json"
for fx in taskstore improver hookinstall; do
  cmp -s "$base" "$here/fixtures/$fx/.claude/verification/checklist.json" && ok "$fx と同じ" || bad "$fx の checklist.json が違う"
done
"$py" "$here/tools/gen-static-rules.py" "$base" --check "$here/profiles/static-rules/CLAUDE.md" && ok "P1 の CLAUDE.md が checklist.json と一致" || bad "P1 の CLAUDE.md が古い（tools/gen-static-rules.py で作り直す）"
for fx in snapkit taskstore improver hookinstall; do
  (cd "$here/fixtures/$fx" && "$py" -B -m unittest discover -s tests >/dev/null 2>&1) && ok "$fx: 見える側のテストが通る" || bad "$fx: 見える側のテストが落ちる"
done
echo "== プロファイルの install（AHE の準備と同じ手順。P2 の hook が settings.json に入る）"
ahe="${AHE_DIR:-$here/../../agent-harness-eval}"
ahepy="$ahe/.venv/bin/python"; [ -x "$ahepy" ] || ahepy="$py"
ic="$(PYTHONPATH="$ahe" "$ahepy" "$here/tools/install-check.py" 2>&1)" && ok "install-check（3 プロファイルすべて期待どおり）" || { echo "$ic" | grep -E "FAIL|Error|install-check"; bad "install-check"; }
echo "== 認証情報らしい文字列が eval/ にない"
if grep -rEq "sk-ant-|oat01|CLAUDE_CODE_OAUTH_TOKEN=[^ ]" "$here" --exclude=selftest.sh --exclude=README.md --exclude=run-eval.sh --exclude-dir=.harness-eval-cache; then bad "認証情報らしい文字列がある"; else ok "なし（名前の inherit_env だけ）"; fi
echo "== E1b（tools/selftest-e1b.sh）"
"$here/tools/selftest-e1b.sh" || bad "selftest-e1b"
[ $fail -eq 0 ] && echo "selftest: すべて期待どおり" || echo "selftest: 失敗あり"
exit $fail
