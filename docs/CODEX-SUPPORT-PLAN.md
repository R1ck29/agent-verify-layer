# Codex 対応計画（agent-verify-layer）

2026-11-18 作成。根拠は Codex CLI 0.170.0 の公式ドキュメント（developers.openai.com/codex の hooks・skills・AGENTS.md・plugins・config-reference・non-interactive・code-review・slash-commands。取得したものは作業ディレクトリの `sources/codex/` にある）と、この環境・Riku の Mac の `~/.codex`。実機での確認はまだしていない（Codex は 11/19 09:04 JST まで上限で止まっている）。

## 結論

**対応できる。** 台帳・HEAD 側チェックリスト・`report`・`doctor` は Node と git だけで動き、ツールに依存しない。Codex 側に要るのは「hook の入出力の違いの吸収」と「verify の起点」の 2 つで、どちらも小さな adapter で済む。リポジトリ名は `agent-verify-layer` に変更した（Claude のプラグイン名 `verify-layer` はそのまま）。

## 1:1 で使えるもの

| 部品 | 理由 |
| --- | --- |
| 台帳（`.git/claude-verify/ledger.jsonl`）・判定（verified / stale / none / skipped） | git の状態だけで決まる。行に `agent: "codex"` を足すだけ（パスは互換のため据え置き） |
| HEAD 側チェックリスト照合 | `git show HEAD:...` と diff だけ。置き場所 `.claude/verification/checklist.json` は Codex でも読める（共通の置き場所 `.agents/verification/` を別名として後で足す） |
| コミットの記録 | Codex の `PostToolUse` は `tool_name: "Bash"`、`tool_input.command` で Claude と同じ形（hooks.md「PostToolUse」）。現行の `hook commit` の処理（HEAD が新しく、未記録か）をそのまま使える |
| `additionalContext` | Codex の `PostToolUse` も `hookSpecificOutput.additionalContext` を受け取り、開発者向けの文脈として足す（既定 2,500 トークンで打ち切り、`additionalContextLimit` で調整） |
| `report` / `doctor` の本体 | ツール非依存。`doctor` に Codex の項目を足すだけ |

## adapter が要るもの

1. **hook の配線の違い**
   - Codex の hook には `if` がない。matcher は `^Bash$` の正規表現にし、スクリプトの先頭で `git commit` を含まないコマンドは即終了（数 ms）。Bash は失敗したコマンドでも PostToolUse が来るので、HEAD が変わったかで判定する（現行どおり）
   - Codex にはツールとしての `Skill` がない（スキルは本文を読む形で使われる）。そのため「Skill(verify) の PostToolUse」は使えない
   - Codex の非管理 hook は**信頼の確認が必要**（`/hooks` で確認するまで実行されない。ハッシュが変わると再確認）。インストーラは導入後に「`/hooks` で信頼してください」と案内し、`doctor` で未信頼を検出する。自動化だけは `--dangerously-bypass-hook-trust` があるが、既定では使わない
   - Windows は `commandWindows` で別コマンドを指定できる。Node の exec 形式にそろえる
   - 置き場所: `~/.codex/hooks.json`（ユーザー）、`<repo>/.codex/hooks.json`（信頼済みプロジェクトだけ）、またはプラグイン（`.codex-plugin/plugin.json` と `hooks/hooks.json`）。Claude と同じく「プラグイン形式」と「hooks.json へのマージ」の両方を用意する
2. **verify の起点**: Codex には「verify という名前のスキルがあればコミット前に実行する」標準の指示がない。代わりに次を組む
   - リポジトリのスキル `.agents/skills/verify/SKILL.md`（Claude の `.claude/skills/verify/` と中身を共有。シンボリックリンクか、`/verify` が記録した手順を参照する薄いスキル）。**skill-creator で作る**
   - そのスキルの最後の手順に「チェックが通ったら `node <layer>/scripts/vl.js mark verify` を実行する」を入れる。`mark` は**チェックが終わった時点の**ツリーを記録する新しいサブコマンド。これは Claude 側の実機スモークで見つかった「Skill を編集前に読み込むと stale と出る」問題も直すので、Claude 側にも同じ手順を入れる
   - AGENTS.md に 1〜2 行（「コミット前に `$verify` を使う。docs とテストだけの変更は除く」）。共有・個人の既存 AGENTS.md に追記する形で、上書きはしない
3. **レビュアー**: Codex の `/review`（と `codex review`）が同梱のレビュアー。設計の「レビュアーは 1 体」は Codex では `/review` にあたる。`/review` は会話内のコマンドで hook のイベントにならないので、実行の記録は `codex review` を包む小さなコマンド（`vl.js review-run`）か、記録しない（レビューの再現率は E2 で別に測る）のどちらか。初版は記録しない

## 既存の ~/.codex ハーネスとの重なり

- `~/.codex/hooks.json`: sample-harness（`samplectl-*`）と code-review-graph の hook だけ。コミットや verify を記録するものはない → 重ならない。マージは自分の hook を絶対パスで見分ける（Claude 側のインストーラと同じ）
- スキル（`~/.agents/skills`）: `independent-verification`、`review-changes`、`refactor-safely` などがあるが、名前が `verify` のものはなく、台帳もない。`independent-verification` は「別の視点で確かめる」指示で、記録と HEAD 側チェックリストは持たない → 補完
- `~/.codex/AGENTS.md`（268 行）: レビューやコミットの一般的な指示はあるが、verify の実行・記録の指示はない。追記は 2 行以内にする
- 手元には wikiskill と agent eval があるが、どちらも検証の記録はしない

## この環境の制約

- GitHub に届かない: ZIP で入れる。Codex のプラグインを git のマーケットプレイスから入れる経路は使えないので、ローカルのプラグインディレクトリか hooks.json へのマージにする
- 導入先に Codex がない可能性: `INSTALL_FOR_CLAUDE.md` の検出で `codex --version` と `~/.codex` を見て、なければ Codex 部分を飛ばす（Claude 部分だけ入れる）。Codex があっても、版が hooks の PostToolUse に対応していなければ飛ばす
- Codex 側の hook の信頼の確認は利用者の操作が要る。管理型 hook（`requirements.toml`）で配る組織なら、その経路を案内する

## 実装の手順（Claude Code が実装し、Codex がレビュー）

1. `vl.js` に `--agent codex|claude` の検出（入力の `turn_id`・`model` などから）と `mark` サブコマンド。台帳の行に `agent` を足す
2. `codex/hooks.json`（プラグイン用）と `scripts/install.js --agent codex`（`~/.codex/hooks.json` へのマージ・削除・`--check`）
3. 共有の verify スキル（skill-creator で作成）と AGENTS.md / CLAUDE.md の 2 行
4. `doctor` に Codex の項目（版、`features.hooks`、hook の信頼、プロジェクトの信頼、`.agents/skills/verify`）
5. テスト（Codex 形式の入力の固定例、マージの冪等性）と CI
6. `INSTALL_FOR_CLAUDE.md` を「Claude と Codex の両方」に広げる（名前は互換のため据え置き、`INSTALL_FOR_AGENTS.md` を別に置くかは実装時に判断）

## 評価（11/19 09:04 以降）

- agent-harness-eval で `agent: codex` のプロファイルを使い、Claude 側と同じ 8 タスク（罠 4・対照 4）を、層なし／AGENTS.md に同じ規則を書いただけ／層ありの 3 通りで回す。モデルは gpt-6.2-sol（日常）を主に、余裕があれば gpt-6.2-astra でも 1 回ずつ
- 判定の基準は Claude 側と同じ（事前に固定）。Codex 側で効果が出なければ、Codex 部分は配らない
- クロスレビュー: Claude が書いた PR を Codex（gpt-6.2-astra）がレビューする

## 未確認

- Codex 0.170 の PostToolUse が `codex exec` の非対話実行でも発火するか、hook の信頼が評価の一時ホームでどう扱われるか（`--dangerously-bypass-hook-trust` を評価だけで使うかどうか）
- `exec_command`（unified exec）経由の `git commit` が `Bash` として来るか（ドキュメントでは来る）
- AGENTS.md の指示だけで Codex がコミット前に verify スキルを使う割合
