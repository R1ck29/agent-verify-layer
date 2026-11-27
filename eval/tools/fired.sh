#!/bin/sh
# 作業ツリー（未コミットの変更つき）に対して、実際の hook（vl.js hook skill）を 1 回走らせ、
# 発火したチェックリスト項目の id を空白区切りで出す（なければ空）。台帳は一時の場所に出る。
# 使い方: fired.sh WORKDIR
set -eu
dir="$1"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cfg="$(mktemp -d)"
printf '{"mode":"observe"}\n' > "$cfg/config.json"
printf '{"tool_input":{"skill":"verify"},"cwd":"%s","session_id":"selftest"}' "$dir" \
  | VL_CONFIG_DIR="$cfg" node "$root/scripts/vl.js" hook skill > /dev/null
led="$dir/.git/claude-verify/ledger.jsonl"
[ -f "$led" ] || { echo "ERR no-ledger"; exit 1; }
node -e '
const rows = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
const run = rows.filter((r) => r.kind === "run").pop();
process.stdout.write((run.fired || []).join(" ") + "\n");
' "$led"
