# Changelog

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に沿います。版は [SemVer](https://semver.org/lang/ja/) です。

## [Unreleased]

### 追加

- Codex CLI 対応（0.170 の文書に基づく。実機の確認は未）: `vl.js hook commit --agent codex`（Codex の PostToolUse `^Bash$`。`turn_id` があれば Codex と判定）、`install.js --agent codex`（`$CODEX_HOME/hooks.json` へのマージ、`--agents-md` で AGENTS.md に 2 行、`--repo-skill` で `.agents/skills/verify/` に雛形を写す。既定は確認だけ）、Codex 用の verify スキルの雛形 `codex/skills/verify/SKILL.md`、`doctor` の Codex 項目（Codex がなければ飛ばす）。台帳の行に `agent` を足した（ない行は claude として読む）
- `vl.js mark verify`: 確認が終わった時点のツリーを verify の記録（`via: "mark"`）として残す。Claude 側でも `Skill(verify)` の hook が返す文脈で案内する（verify を編集前に読み込むと stale と出る問題の対策）

### 修正

- 独立レビュー（Codex、`XREVIEW-codex.md`）の指摘 12 件と提案への対応（回答は `docs/REVIEW-NOTES.md` の「Codex レビュー（11/19）への回答」）:
  - `doctor` の smoke が、親の `GIT_DIR` 等を継承して利用者のリポジトリを変更し得た。隔離環境で実行する
  - スナップショット（`git add -A`）の失敗が正常な tree になり、変更パスの取得失敗が `skipped` になっていた。`unknown` として分けて数える
  - project スコープの設定のバックアップがコミット候補になった。ignore されていなければ書かず、バックアップは作業ツリーの外に置く
  - Codex hook のパスがシェルに評価されていた。引用を共通化し、表現できないパスは書き込み前に拒否
  - 他者の同名 hook を自分のものとして外していた。event・matcher・コマンド形の完全一致だけを自分のものとする
  - `--repo-skill` がシンボリックリンクでリポジトリの外に及んでいた。外に解決されるときは何もしない。書き込み対象はすべて先に検査し、値のないオプションは exit 2
  - Codex が作っていないコミットを記録していた。実際の `git commit`（reflog で確認）だけを記録し、並行する hook は台帳のロックで 1 行に
  - `verified` を設計書の原本どおり作業ツリーのハッシュの一致に戻した（`paths_match`、`head_tree_match` は別集計）
  - 空白入りファイル名でチェックリストの追加行が落ちていた、BOM 付き config で hook と installer が食い違っていた、`report` の期間起点と mark 経路の発火数が観察できないケースを落としていた

- `install.js --agent codex --repo-skill` が利用者全体の hook のマージ・削除も一緒に行っていた。リポジトリのスキルだけを扱うようにした
- `install.js` が `module.exports` より前に `main()` を呼んでいたため、`--agent codex` が毎回「t.removeOwn is not a function」で失敗していた
- 実機の Claude Code 2.1.325 で、`if: "Skill(verify)"` の PostToolUse hook が起動せず、run 行が台帳に書かれなかった（commit 行が `none` になる）。Skill の hook を `if` なしの `matcher: "Skill"` 1 本（`vl.js hook skill`）にし、スクリプト側で `tool_input.skill` から verify / 入れ子の verify / code-review（別名 `review`）を判定して記録し、ほかのスキルでは何もせず終了するようにした。`hook run <verify|code-review>` は `hook skill` に置き換わった（`install.js --apply` で入れ直すと古い登録は置き換わる）。Bash の `if` は実機で当たったので変更なし。詳細は `docs/SMOKE.md`

## [0.2.0] - 2026-11-27

### 追加

- `verify-diff` が依頼開始時と検証時の隔離コピーで公開入口を比較します。指定 assertion と実引数を計測し、既存公開テストの回帰を確認して、最終スナップショットに結び付いた証拠を台帳に残します。
- リポジトリ単位の `verifyV2.mode` と、Claude Code・Codex 用の開始および Stop hook を追加しました。`observe` は記録のみ行い、`enforce` は対応ランナーで未検証の場合に依頼ごとに最大 1 回介入します。
- 公開テストからのランナー判定と設定生成、`verify2` スキル、導入・削除コマンド、doctor 診断を追加しました。既存の v0.1 観察モードも利用できます。

### 修正

- Node で直接 `await` する等値比較を扱い、計測した実引数とケース入力が異なる実行を未検証にします。

## [0.1.0] - 2026-11-18

観察モードだけの初版。仕様は `docs/REVIEW-NOTES.md` 第 5 節「調整済み計画」です（設計書 `docs/DESIGN-source.md` と食い違う点はレビューノートを優先）。

### 追加

- `scripts/vl.js hook run <verify|code-review>` / `hook commit` / `hook expand`: verify・code-review の実行と成功したコミットを、`git rev-parse --git-path claude-verify` 下の `ledger.jsonl` に記録する。コミットは verified / stale / none / skipped に分類する。プロンプト、`command_args`、コマンド、ファイル名は記録しない。壊れた入力でも例外は握りつぶして exit 0
- HEAD 側の `.claude/verification/checklist.json` 照合（`git show HEAD:`）。当たった項目だけを `additionalContext` で渡す。チェック自体を触る変更には警告を添え、台帳に `self_check_change` を残す
- `scripts/vl.js report`（内訳、verified 率、stale の大きさ、項目の発火数、hook の p50/p95、`git log` との突き合わせ）と `doctor`（版・OS・Node・管理設定・標準の verify 指示が消える条件・同名スキル・配線の確認、各 hook への擬似入力）
- プラグイン形式（`.claude-plugin/plugin.json`、`marketplace.json`、`hooks/hooks.json`。exec 形式、`Bash|PowerShell`、`if` は Bash 用と PowerShell 用に分割）
- `scripts/install.js`（プラグインが使えない環境向けの settings.json マージ。`--check` / `--apply` / `--uninstall`、`--scope user|project`、冪等、バックアップ、自分の hook を `vl.js` の絶対パスで識別、他の hook は変更しない）
- `rules/verification.md`（Rules の 2 行）、`examples/checklist.json`
- `INSTALL_FOR_CLAUDE.md`（導入先の Claude Code が読んで実行する手順書）、`README.md`
- `node --test` の 87 件、GitHub Actions の CI（ubuntu / macos / windows × Node 18 / 22）

### 設計書からの変更

- 観察は PostToolUse（成功したコミット）だけにした。PreToolUse には載せない
- 判定を、コミットに含まれるファイルについての「verify 開始時のツリーと HEAD の差」にした
- OTEL テレメトリ、SQL 向けの個人用 verify、enforce、掘り起こしと刈り込みの自動化は含めない

### 修正（開発中に見つけたもの）

- 一時インデックスのコピーが元の mtime を失い、git の racy-clean 判定が効かずに、編集直後の同サイズの変更を見落として stale なツリーを記録することがあった。コピーの mtime を元に合わせた
- インストーラが、`vl.js` を文字列として含むだけの他人のシェル形式 hook を自分のものと誤認して削除する不具合を直した
