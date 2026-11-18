# Changelog

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に沿います。版は [SemVer](https://semver.org/lang/ja/) です。

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
