## 概要

agent-verify-layer v0.1.0（観察モードの検証レイヤー）の実装です。Claude Code 向けの観察の台帳とチェックリスト照合に加えて、Codex CLI 向けの記録・導入・診断を実装しました（Codex は文書に基づく実装で、実機は未確認）。**この PR はマージしません（draft のまま）。** 理由は下の「評価」です。仕様の最上位は設計書の原本（`docs/DESIGN-source.md`）で、`docs/REVIEW-NOTES.md` が原本から変えた点は変更案として承認待ちです。

- **台帳**（`scripts/vl.js hook skill|commit|expand`）: verify / code-review の実行と、成功した `git commit` を `git rev-parse --git-path claude-verify` 下の `ledger.jsonl` に記録します。コミットは verified / stale / none / skipped / unknown に分類します（`verified` は原本どおり作業ツリーのハッシュの一致）。プロンプト、`command_args`、コマンド、ファイル名は記録しません。壊れた入力でも exit 0 です。行に `agent`（`claude` / `codex`）があります。
- **HEAD 側チェックリスト照合**: `git show HEAD:.claude/verification/checklist.json` だけを読み、当たった項目だけを `additionalContext` で渡します（Codex は `mark verify` の出力）。チェック自体を触る変更には警告を添えます。
- **`vl.js mark verify`**: 確認が終わった時点のツリーを記録します（verify を編集前に読み込むと偽の stale になる問題への対策）。
- **Codex 対応**: `install.js --agent codex`（`$CODEX_HOME/hooks.json` のマージ、`--agents-md`、`--repo-skill`。既定は確認だけ、冪等、他者の hook は変更しない）、`codex/skills/verify/SKILL.md`、`doctor` の Codex 項目。
- **`report` と `doctor`**、導入物（プラグイン形式、`scripts/install.js`、`rules/verification.md`、`INSTALL_FOR_CLAUDE.md`、`README.md`、`CHANGELOG.md`）。

## 評価（この PR をマージしない理由）

- **E1b（実リポジトリの罠、事前に固定した規則）: Claude 側は「有用でない」**。罠の合格は P0（層なし）9/12・P1（CLAUDE.md にルール）10/12・P2（この層）9/12、対照は 8/8。P2 は P0 を上回らず（改善 1・後退 1）、4/12 でしか verify を呼んでいません。数値と限界は `eval/RESULTS-E1b.md`（ブランチ `feat/e1b-hard`）。Codex 側は各セル 1 試行の予備結果で、判定は出していません。E1（縮小版）は P0 が天井で判定不能でした。
- v0.1 の層は観察の台帳としては動きますが、評価で効果を示せていません。**改善版 v0.2 を `feat/v0.2` で設計中**で、held-out の罠で決定評価する予定です。

## 独立レビュー（Codex）への対応

Codex gpt-6.2-astra の独立レビュー（VERDICT: CHANGES_REQUESTED。ブロッキング 12 件と提案）に、テスト先行で対応しました。回答の全文は `docs/REVIEW-NOTES.md` の「Codex レビュー（11/19）への回答」です。

- 直した: #1 doctor の Git 環境隔離、#2 project スコープの設定とバックアップのコミット混入防止、#3 Codex hook のシェル引用、#4 hook の所有判定（他者の hook を外さない）、#5 `--repo-skill` のリポジトリ外への配置・削除の防止、#6 コミットの帰属（実際の `git commit` だけを記録）、#7 スナップショット・差分の取得失敗を `unknown` に、#9 並行 hook の重複記録（台帳のロック）、#10 空白入りファイル名、#11 BOM 付き config、#12 report の期間起点と mark 経路の集計。提案（非 Git 指定のメッセージ、部分導入、引数検証、連続 amend、symlink と警告の切り詰め、project の Codex config、文書の矛盾）も対応済みです。
- **一部だけ同意**: #8 `verified` は、原本どおり「作業ツリーのハッシュの一致」に戻しました。Codex の提案（コミットの tree 全体の一致を条件にする）は採らず、`paths_match`・`head_tree_match` を別集計にして部分コミットが見えるようにしました。厳しい定義に切り替えるかは Riku の判断（承認待ち）です。
- 修正ごとに独立した reviewer の PASS を記録しています（install-safety は 1 度 FAIL して直しました）。

## 検証

- `node --test`: 180 件、180 件成功（一時 git リポジトリ、一時 HOME・`CODEX_HOME`、偽の `codex` コマンドだけを使用。本物の `~/.codex`・`~/.claude` には触れません）。
- CI: ubuntu / macos / windows × Node 18 / 22。**最後に実行された CI（4b371bb）は ubuntu・macOS が全件成功、Windows 2 構成が失敗**（doctor の隔離環境が Windows の `os.devNull` を git の config として読めなかった。57c4949 と c3854af で直した）。**その後の push では、GitHub Actions が課金・支出上限でジョブを開始できず（"recent account payments have failed or your spending limit needs to be increased"）、Windows の修正は CI で未確認**です。上限の解除後に `gh run rerun` で再実行してください。Linux ではローカルで 180/180 成功しています。

## 未確認（隠さずに書きます）

- Claude で**実機確認済み**: Skill の hook、`Bash(git commit *)` の `if`、commit 行、`report` の突き合わせ（`docs/SMOKE.md`）。
- **未確認**: `UserPromptExpansion`（利用者が打った `/verify`）、PowerShell の `if`、Windows の実機、導入先の Claude Code 2.1.321。
- **Codex は実機未確認**: PostToolUse `^Bash$` が実際の `git commit`（unified exec 経由を含む）で発火するか、`/hooks` での信頼と再確認、`codex exec` での発火、AGENTS.md の 2 行で `$verify` と `mark verify` が使われる割合、Windows の command 文字列。テストの Codex 入力は文書から作った fixture で、実機で採取したものではありません。

## テスト計画

- [x] `node --test`（180 件）
- [ ] CI（最終コミットで 6 構成が緑。Actions の課金上限の解除待ち）
- [ ] ログイン済みの端末で `docs/SMOKE.md` の手順、Codex の実機確認（レビュー後）

🤖 Generated with [Claude Code](https://claude.com/claude-code)
