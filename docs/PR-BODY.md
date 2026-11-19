# PR #1 本文に足す節: Codex 対応（2026-11-19）

PR #1 の本文の「未確認」の前に、次の節を入れてください（`gh pr edit` はしていません）。タイトルの「Codex は計画」は「Codex 対応（実機未確認）」に改めるのがよいと思います。

---

## Codex CLI 対応（0.170 の文書に基づく。実機は未確認）

計画とそのレビューは `docs/CODEX-SUPPORT-PLAN.md` にあります。台帳・判定・HEAD 側チェックリスト・`report` は Claude と共通です。台帳の行に `agent`（`claude` / `codex`）を足しました。この項目がない古い行は claude として読みます。

- **`vl.js mark verify`**（e251f50）: 確認が**終わった時点**のツリーを `via: "mark"` の verify の記録として残し、その時点の diff に当たるチェックリストの項目を出します。Claude 側では、`Skill(verify)` の hook が返す文脈で案内します。verify を編集前に読み込むと stale と出る、実機スモークで見つかった問題への対策です。
- **コミットの hook**（360878a）: Codex の PostToolUse `^Bash$` に `node "<絶対パス>/vl.js" hook commit --agent codex` を 1 本（`timeout: 10`）置きます。Codex の hook には `if` がないので、`git … commit` を含まないコマンドはスクリプトの先頭で即終了します。`--agent` がないときは、入力に `turn_id` があれば Codex と判定します。
- **インストーラ** `install.js --agent codex`:
  - `$CODEX_HOME/hooks.json` へのマージです。既定は確認だけで、2 回目の `--apply` は 1 バイトも変えません。他の hook は変更しません。
  - `--agents-md` は AGENTS.md の末尾に 2 行を足します。空でない `AGENTS.override.md` があれば、そちらに書きます。
  - `--repo-skill` は別の操作で、リポジトリに verify スキルを写すだけです。`hooks.json` と AGENTS.md には触れません。既定は確認だけで、既存のものは上書きしません。
  - Codex がない端末では何も書かず、Claude の部分だけを入れるよう案内します。
  - `allow_managed_hooks_only` のときは書き込みを止めます。
- **verify スキルの雛形** `codex/skills/verify/SKILL.md`: skill-creator の指針で作りました。確認の手順は持たず、Claude の `/verify` が記録した `.claude/skills/verify/SKILL.md` に従います（手順は 1 か所）。最後の手順で、AGENTS.md にある mark の行を実行します。Claude のプラグインのスキルにはしていません。
- **`doctor` の Codex 項目**: 版、`features.hooks`、`allow_managed_hooks_only`、hook の配線と重複、`/hooks` での信頼の確認手順、プロジェクトの信頼、`.agents/skills/verify`、個人用の verify、AGENTS.md の 2 行と大きさを見ます。Codex がない端末では、1 行の案内を出して飛ばします。
- **文書**: `INSTALL_FOR_CLAUDE.md` を Claude と Codex の両方に広げました。Codex がない端末では Codex の部分を飛ばします。「部分的に入れる」の表で、Claude だけ・Codex だけ・両方を選べます。README には Codex の節を足しました。
- **CI**: 各 OS で「Codex がない環境で Codex の部分が飛ばされ、何も書かれない」ことを確かめる手順を足しました。あわせて concurrency と job の timeout を設定しました。

### この作業で見つかって直した不具合

- `install.js` が `module.exports` より前に `main()` を呼んでいたため、`--agent codex` が毎回失敗していました（テストを書いて発覚）。
- `hooks.json` の `hooks` や `hooks.PostToolUse` が想定と違う形（オブジェクトや文字列など）のとき、`--apply` が他人の hook を黙って消していました。Claude 側の settings.json も同じでした。今は両方とも exit 2 で止まり、何も書きません。独立レビューで FAIL になって発覚しました。
- `--repo-skill` が利用者全体の hook のマージ・削除も一緒に行っていて、「リポジトリのスキルだけ」の承認では使えませんでした（文書の独立レビューの FAIL で発覚）。今はスキルだけを扱います。
- プロジェクトの信頼を引くパスの比較が、Windows の 8.3 形式の短い名前で外れていました（Windows の CI で発覚）。

### 検証

- `node --test`: 全件成功（件数は最終の CI を参照）。テストは一時的な HOME・`CODEX_HOME` と、偽の `codex` コマンド（`VL_CODEX_BIN`）だけを使います。本物の `~/.codex`・`~/.claude` には触れません。
- 各ノード（codex-adapter / codex-installer / codex-skill / doctor-codex / docs / ci-push）は、独立した reviewer が判定し、その結果を `task-graph.json` に記録しています。codex-installer（上の 2 つ目の不具合）と docs（上の 3 つ目の不具合と、文書の記述の誤り）は 1 度 FAIL になり、直してから再レビューしました。

### 未確認（Codex の実機で確かめること）

- Codex 0.170 で、PostToolUse `^Bash$` が実際の `git commit`（unified exec の `exec_command` 経由を含む）で発火し、台帳に `agent: codex` の行が出るか
- `/hooks` での信頼の手順と、`vl.js` を更新したときに再確認を求められるか（文書では、`hooks.json` の hook は定義のハッシュに対して信頼される）
- `codex exec`（非対話）で hook が発火するか。評価の一時ホームで信頼がどう扱われるか
- AGENTS.md の 2 行だけで、Codex がコミット前に `$verify` を使い、`mark verify` を実行する割合（評価 E1 の Codex 版で測る）
- Windows での `command` 文字列（cmd / PowerShell）の実行
