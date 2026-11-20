# Codex 対応計画（agent-verify-layer）

2026-11-18 作成。根拠は Codex CLI 0.170.0 の公式ドキュメント（developers.openai.com/codex の hooks・skills・AGENTS.md・plugins・config-reference・non-interactive・code-review・slash-commands。取得したものは作業ディレクトリの `sources/codex/` にある）と、この環境・Riku の Mac の `~/.codex`。実機での確認はまだしていない（Codex は 11/19 09:04 JST まで上限で止まっている）。

## 結論

**対応できる。** 台帳・HEAD 側チェックリスト・`report`・`doctor` は Node と git だけで動き、ツールに依存しない。Codex 側に要るのは「hook の入出力の違いの吸収」と「verify の起点」の 2 つで、どちらも小さな adapter で済む。リポジトリ名は `agent-verify-layer` に変更した（Claude のプラグイン名 `verify-layer` はそのまま）。

## 1:1 で使えるもの

| 部品 | 理由 |
| --- | --- |
| 台帳（`.git/claude-verify/ledger.jsonl`）・判定（verified / stale / none / skipped） | git の状態だけで決まる。行に `agent: "codex"` を足すだけ（パスは互換のため据え置き） |
| HEAD 側チェックリスト照合 | `git show HEAD:...` と diff だけ。置き場所 `.claude/verification/checklist.json` は Codex でも読める（共通の置き場所 `.agents/verification/` を別名として後で足す） |
| コミットの記録 | Codex の `PostToolUse` は `tool_name: "Bash"`、`tool_input.command`（文字列）で、この 2 つは Claude と同じ形（hooks.md「PostToolUse」）。unified exec（`exec_command`）も `Bash` として来る。`tool_response` の形は文書にない（使わない）。現行の `hook commit` の処理（HEAD が新しく、未記録か）をそのまま使える |
| `additionalContext` | Codex の `PostToolUse` も `hookSpecificOutput.additionalContext` を受け取り、開発者向けの文脈として足す（既定 2,500 トークンで打ち切り、`additionalContextLimit` で調整） |
| `report` / `doctor` の本体 | ツール非依存。`doctor` に Codex の項目を足すだけ |
| 出力 | PostToolUse の stdout は JSON だけが読まれ、ただの文字列は捨てられる（hooks.md「PostToolUse」）。現行の出力（JSON か空、終了コード 0）のままでよい |

## adapter が要るもの

1. **hook の配線の違い**
   - Codex の hook には `if` も `args`（exec 形式）も `onFailure` もない。`command` は 1 本の文字列で、シェルを通して実行される。既定の timeout は 600 秒なので、`timeout: 10` を明示する。matcher は `^Bash$` の正規表現にし、スクリプトの先頭で `git … commit` を含まないコマンドは即終了（数 ms）。Bash は失敗したコマンドでも PostToolUse が来るので、HEAD が変わったかで判定する（現行どおり）。Claude の `hooks/hooks.json` はそのままでは使えないので、Codex 用はインストーラが絶対パスで組み立てる
   - Codex にはツールとしての `Skill` がない（スキルは本文を読む形で使われる）。そのため「Skill(verify) の PostToolUse」は使えない
   - Codex の非管理 hook は**信頼の確認が必要**（`/hooks` で確認するまで実行されない。定義のハッシュが変わると再確認）。インストーラは導入後に「`/hooks` で信頼してください」と案内する。信頼の状態の保存場所は文書にないので、`doctor` では検出せず、確認の手順を案内するだけにする。自動化だけは `--dangerously-bypass-hook-trust` があるが、既定では使わない
   - Windows は `commandWindows` で別コマンドを指定できる。シェルの種類は文書にないので、インストーラは導入先の OS のパスで `node "<絶対パス>/vl.js" hook commit --agent codex` の形（cmd と PowerShell のどちらでも通る形）を `command` に書く。Windows のシェルは Bash ツールとして来るので、PowerShell 用の配線は要らない
   - 置き場所: `/etc/codex/hooks.json`（システム）、`$CODEX_HOME/hooks.json`（ユーザー。既定 `~/.codex/hooks.json`）、`<repo>/.codex/hooks.json`（信頼済みプロジェクトだけ）、各層の `config.toml` の `[hooks]`、またはプラグイン。**どの場所の hook も合算され、同じものを 2 か所に書くと 2 回走る**（同時に起動される）。そのため初版は `$CODEX_HOME/hooks.json` へのマージだけにし、プラグイン形式は見送る（ローカルのマーケットプレイスが要り、Windows での変数展開も未確認）。`doctor` は 2 か所以上の登録を警告する
2. **verify の起点**: Codex には「verify という名前のスキルがあればコミット前に実行する」標準の指示がない。代わりに次を組む
   - リポジトリのスキル `.agents/skills/verify/SKILL.md`（`/verify` が記録した `.claude/skills/verify/SKILL.md` の手順を参照する薄いスキル。シンボリックリンクは Claude 側の記録を Codex 用の手順で汚すので使わない）。雛形は `codex/skills/verify/` に置き、**skill-creator で作る**。Claude のプラグインのスキルにはしない（プラグインのスキルは標準の指示の対象外で、名前も衝突する）。各リポジトリへは、利用者の承認のうえで `install.js --agent codex --repo-skill` が写す（既定は確認だけ、既存は上書きしない）
   - そのスキルの最後の手順に「チェックが通ったら mark のコマンドを実行する」を入れる。`vl.js mark verify` は**チェックが終わった時点の**ツリーを記録する新しいサブコマンド。これは Claude 側の実機スモークで見つかった「Skill を編集前に読み込むと stale と出る」問題も直すので、Claude 側にも同じ手順を入れる（Claude の記録済みの SKILL.md には書かず、`Skill(verify)` の hook が返す文脈に 1 行足す）。vl.js の絶対パスは端末ごとに違うので、コミットされるスキルには書かず、端末ごとの AGENTS.md の行（下）と hook の文脈に書く。mark は、そのときの diff に当たるチェックリストの項目も出す（Codex には Skill の hook がないので、チェックリストを渡す経路はここだけになる）
   - AGENTS.md に 2 行（1 行目「コミット前に、`verify` スキルがあれば `$verify` を使う。docs とテストだけの変更は除く」、2 行目「確認が通ったら `node "<絶対パス>/vl.js" mark verify --agent codex` を実行する」）。既定は利用者全体の `$CODEX_HOME/AGENTS.md`（Claude の標準の指示と同じく「スキルがあれば」の形なので、全リポジトリに置いてよい）。既存の AGENTS.md の末尾に追記する形で、上書きはしない。空でない `AGENTS.override.md` があるとそちらが読まれ AGENTS.md は読まれないので、インストーラは override に書き、doctor はその旨を出す
3. **レビュアー**: Codex の `/review`（と `codex review`）が同梱のレビュアー。設計の「レビュアーは 1 体」は Codex では `/review` にあたる。`/review` は会話内のコマンドで hook のイベントにならないので、実行の記録は `codex review` を包む小さなコマンド（`vl.js review-run`）か、記録しない（レビューの再現率は E2 で別に測る）のどちらか。初版は記録しない

## 既存の ~/.codex ハーネスとの重なり

- `~/.codex/hooks.json`: sample-harness（`samplectl-*`）と code-review-graph の hook だけ。コミットや verify を記録するものはない → 重ならない。マージは自分の hook を絶対パスで見分ける（Claude 側のインストーラと同じ）
- スキル（`~/.agents/skills`）: `independent-verification`、`review-changes`、`refactor-safely` などがあるが、名前が `verify` のものはなく、台帳もない。`independent-verification` は「別の視点で確かめる」指示で、記録と HEAD 側チェックリストは持たない → 補完
- `~/.codex/AGENTS.md`（268 行）: レビューやコミットの一般的な指示はあるが、verify の実行・記録の指示はない。追記は 2 行以内にする
- 手元には wikiskill と agent eval があるが、どちらも検証の記録はしない

## この環境の制約

- GitHub に届かない: ZIP で入れる。Codex のプラグインを git のマーケットプレイスから入れる経路は使えない。ローカルのマーケットプレイスなら入るが、初版は hooks.json へのマージだけにする（レビューの 3）
- 導入先に Codex がない可能性: `INSTALL_FOR_CLAUDE.md` の検出で `codex --version` と `~/.codex` を見て、なければ Codex 部分を飛ばす（Claude 部分だけ入れる）。Codex があっても、版が hooks の PostToolUse に対応していなければ飛ばす
- Codex 側の hook の信頼の確認は利用者の操作が要る。管理型 hook（`requirements.toml`）で配る組織なら、その経路を案内する

## 実装の手順（Claude Code が実装し、Codex がレビュー）

1. `vl.js` に `--agent codex|claude`（Codex 用の hook は引数で明示。引数がなければ入力の `turn_id` の有無で判定。Codex は `CLAUDE_PLUGIN_ROOT` も設定するので環境変数では見分けない）と `mark` サブコマンド。台帳の行に `agent` を足す
2. `scripts/install.js --agent codex`（`$CODEX_HOME/hooks.json` へのマージ・削除・`--check`、AGENTS.md の 2 行、`--repo-skill`）。プラグイン用の `codex/hooks.json` は見送る
3. 共有の verify スキル（skill-creator で作成）と AGENTS.md の 2 行。Claude 側は CLAUDE.md には書かず、`Skill(verify)` の hook が返す文脈で mark を案内する
4. `doctor` に Codex の項目（版、`features.hooks`、`requirements.toml` の `allow_managed_hooks_only` と `features.hooks`、hook の配線と重複、信頼の確認手順の案内、プロジェクトの信頼、`.agents/skills/verify`、個人用の `verify`、AGENTS.md の 2 行）。Codex がなければ 1 行の案内だけにして飛ばす
5. テスト（Codex 形式の入力の固定例、マージの冪等性）と CI
6. `INSTALL_FOR_CLAUDE.md` を「Claude と Codex の両方」に広げる（名前は互換のため据え置き、`INSTALL_FOR_AGENTS.md` を別に置くかは実装時に判断）

## 評価（11/19 09:04 以降）

- agent-harness-eval で `agent: codex` のプロファイルを使い、Claude 側と同じ 8 タスク（罠 4・対照 4）を、層なし／AGENTS.md に同じ規則を書いただけ／層ありの 3 通りで回す。モデルは gpt-6.2-sol（日常）を主に、余裕があれば gpt-6.2-astra でも 1 回ずつ
- 判定の基準は Claude 側と同じ（事前に固定）。Codex 側で効果が出なければ、Codex 部分は配らない
- クロスレビュー: Claude が書いた PR を Codex（gpt-6.2-astra）がレビューする

## 未確認

- Codex 0.170 の PostToolUse が `codex exec` の非対話実行でも発火するか、hook の信頼が評価の一時ホームでどう扱われるか（`--dangerously-bypass-hook-trust` を評価だけで使うかどうか）
- `exec_command`（unified exec）経由の `git commit` が実機でも `Bash` として来るか（ドキュメントでは来る。hooks.md「Tool coverage」）
- AGENTS.md の指示だけで Codex がコミット前に verify スキルを使う割合

## レビュー（2026-11-18）

計画を `sources/codex/`（Codex CLI 0.170 の文書の写し）と照らし、この環境の `codex-cli 0.170.0` と `~/.codex` を読むだけで確かめた。誤りと抜けは上の本文で直した（直した箇所はこの節の番号と対応する）。`changelog.md` の写しは空で、版ごとの対応は確かめられない。

### 誤り（本文を修正）

1. **exec 形式がない**: Codex の command handler の項目は `type`・`command`（文字列）・`commandWindows`・`timeout`（既定 600 秒）・`statusMessage`・`additionalContextLimit`・`async` で（ほかに `mcp_tool` の handler がある）、`args`・`if`・`onFailure` は文書にない（hooks.md 183-199）。「Node の exec 形式にそろえる」は誤り。Claude の `hooks/hooks.json` は使い回せない。Codex 用は、インストーラが絶対パスで組んだ `node "<path>/vl.js" hook commit --agent codex` を `command` に書き、`timeout: 10` を明示する
2. **信頼の検出は doctor でできない**: 信頼はハッシュに対して記録される（hooks.md 67-83）が、保存場所は文書にない。`doctor` は検出せず、`/hooks` での確認を案内する。プラグインの hook は同梱スクリプトの変更でも再確認になるが、`hooks.json` の hook は「定義」のハッシュに対して信頼される（hooks.md 67-72）ので、`vl.js` を更新しても再確認は求められない**と推測される**（文書には明記がない。実機で確かめる）
3. **プラグインとマージの両方を用意すると二重に走る**: 全ての場所の hook が合算され、同じ command を 2 か所に書くと 2 回走る。同じイベントの hook は同時に起動される（hooks.md 15-19, 61-65）。「未記録か」の確認が競合しうる。初版はマージだけにし、doctor が重複を警告する。プラグインは、ローカルのマーケットプレイス（`.agents/plugins/marketplace.json`、config-reference.md の `marketplaces.*`）が要り、「ローカルのプラグインディレクトリ」だけでは入らない（本文「この環境の制約」の 1 行目も同じ）
4. **エージェントの判定に環境変数は使えない**: Codex はプラグインの hook に `CLAUDE_PLUGIN_ROOT` も設定する（hooks.md 406-413）。Codex 用の hook は `--agent codex` を明示し、なければ入力の `turn_id`（Codex だけの項目、hooks.md 919-925）で判定する

### 抜け（本文に追加、または実装で扱う）

5. **置き場所**: `/etc/codex/hooks.json`、`$CODEX_HOME`（未設定なら `~/.codex`）、各層の `config.toml` の `[hooks]` が抜けていた（hooks.md 33-50）。インストーラと doctor は `CODEX_HOME` に従う
6. **Codex でのチェックリストの渡し方**: Codex には Skill の hook がない（スキルを使ったことを示すイベントもない。hooks.md 23-29、skills.md 46）。`mark verify` が、そのときの diff に当たる項目を出力する形にする（確認が終わった時点の diff なので、編集前に verify を読んだ場合の「何も当たらない」問題も避けられる）
7. **mark のコマンドの置き場所**: vl.js の絶対パスは端末ごとに違う。コミットされる `.agents/skills/verify/SKILL.md` には書けないので、端末ごとの AGENTS.md の 2 行目に書き、スキルは「AGENTS.md に検証レイヤーの mark の行があれば実行する。なければ飛ばす」とする。層が入っていない端末でもスキルは壊れない
8. **AGENTS.md の読み込み**: 利用者全体は、空でない `AGENTS.override.md` があればそちらだけが読まれる。各ディレクトリで 1 ファイルだけ、合計 `project_doc_max_bytes`（既定 32 KiB）で打ち切り（guides_agents-md.md 9-15）。追記先は override を優先し、doctor は大きさを見る
9. **unified exec の遅延**: 長いコマンドの PostToolUse は、あとの `write_stdin` のポーリングで届くことがある（hooks.md 466-474）。コミットは数秒で終わるので、現行の「HEAD が 300 秒以内」の条件で足りる。特別な経路の一部は hook を通らない（hooks.md 476-477）。台帳と `git log` の突き合わせ（`report`）で漏れを測る
10. **スキルの発見**: `.agents/skills` は作業ディレクトリからリポジトリの最上位まで、続いて `$HOME/.agents/skills`、`/etc/codex/skills`（skills.md 138-147）。名前が同じスキルは統合されず両方が出る。個人用の `~/.agents/skills/verify` は置かない（doctor が警告）。`agents/openai.yaml` の `allow_implicit_invocation: false` は付けない。スキルの一覧には文脈の約 2% の上限があり、スキルが多いと `verify` が一覧から落ちうる（skills.md 37-41）。AGENTS.md の行で名前を明示するのはその対策も兼ねる
11. **使わないイベント（理由つき）**: `UserPromptSubmit` は `$verify` を打った利用者の操作を拾える（hooks.md 1024-1049）が、matcher が効かず毎回のプロンプトで起動し、記録は「始めた時点」のツリーで stale の誤判定を再現する。mark で足りるので使わない。`SessionStart` での指示の注入と `Stop` での続行の強制は、毎セッション・毎ターンの費用になるか、観察モードを外れるので使わない（設計書「採らなかった案」と同じ理由）
12. **`codex exec` で hook が発火するか**は文書にない（noninteractive.md は hook に触れない。プロジェクトの設定は信頼済みのプロジェクトでだけ読む、66-68）。評価の前に実機で確かめる（「未確認」に残す）

### 既存のハーネスとの重なり（確認済み、本文のとおり）

- `~/.codex/hooks.json` は sample-harness（SessionStart・SessionEnd・Stop・PostToolUse `Edit|Write|…|apply_patch`）と code-review-graph（SessionStart・PostToolUse `Edit|Write`）だけで、`Bash` の PostToolUse はない。この層は PostToolUse `^Bash$` の 1 本だけを足すので重ならない。`[features]` に `hooks` の指定はなく、`codex features list` では `hooks stable true`（既定で有効）
- `~/.agents/skills` に `verify` はない（`independent-verification` などは記録と HEAD 側チェックリストを持たない）
- Codex がない端末では、インストーラの `--agent codex` は何も書かずに止まり、doctor は 1 行の案内だけを出す。Claude の部分はこれまでどおり単独で入る

### 実装で変えた点（本文の手順との差）

- 手順 2 の `codex/hooks.json`（プラグイン用）は作らない（上の 3）
- 手順 3 のスキルは、雛形を `codex/skills/verify/SKILL.md` に置き、リポジトリへの配置は利用者の承認を得てから行う（`install.js --agent codex --repo-skill`。既定は確認だけ）

## 続き（2026-11-18 21:12 JST、Claude の 5 時間枠が上限に達して中断。リセット 11/19 01:30 JST）

済み（push 済み）: 計画のレビュー（上の節）、`vl.js mark verify`（e251f50）、Codex adapter（360878a）。この時点で `npm test` 104/104 合格。
WIP（このコミット）: `scripts/lib/install-codex.js`（`install.js --agent codex`、`--agents-md`、`--repo-skill`）と `install.js`・`codex.js`・`report.js` の配線。テストはまだない。
残り（新しいセッションで、この節と上の「レビュー」を読んでから）:
1. 共有の verify スキルの雛形 `codex/skills/verify/SKILL.md` を skill-creator で作る（install-codex.js が参照しているがまだ無い）。手順に `vl.js mark verify` を入れる
2. install-codex.js のテスト（hooks.json へのマージの冪等性、他者の hook を変えない、AGENTS.md 2 行の追加・削除、--repo-skill は既定で確認だけ）
3. `doctor` の Codex 項目（版、`features.hooks`、hook の信頼、プロジェクトの信頼、`.agents/skills/verify`）とテスト
4. INSTALL 文書を Claude と Codex の両方に広げる（Codex がない環境では Codex 部分を飛ばす）。README の Codex 欄
5. CI（.github/workflows/ci.yml）の更新、push、`gh pr checks 1` が緑になるまで確認、PR #1 の本文に Codex 対応の要約

### 完了（2026-11-19 09:35 JST、新しいセッション）

残りの 1〜5 を終えた。

1. `codex/skills/verify/SKILL.md`（skill-creator の指針で作成。重い評価ループは省いた）。確認の手順は `.claude/skills/verify/SKILL.md` の 1 か所だけに置き、スキル側は最後の手順で AGENTS.md の mark の行を実行する
2. `tests/install-codex.test.js`（一時 HOME・`CODEX_HOME`・`VL_CODEX_BIN`。本物の `~/.codex` には触れない）。この過程で 2 件を直した。1 件目は `install.js` が `module.exports` より前に `main()` を呼んでいて、`--agent codex` が毎回失敗していたこと。2 件目は、形の違う `hooks` / `hooks.PostToolUse` で他人の hook が消えていたこと。こちらは独立レビューの FAIL で見つかり、Claude 側の settings.json も同じだった
3. `scripts/lib/doctor-codex.js` と `tests/doctor-codex.test.js`。Codex がなければ 1 行の案内だけを出して飛ばす
4. `INSTALL_FOR_CLAUDE.md` の第 9 節と「部分的に入れる」、README の「Codex」節、CHANGELOG。文書の独立レビューの FAIL で、`--repo-skill` が利用者全体の hook のマージ・削除も一緒に行っていたと分かった。スキルだけを扱う別の操作に直した
5. CI に「Codex がない環境で Codex の部分が飛ばされる」手順と concurrency・timeout を足した。PR 本文の追記案は `docs/PR-BODY.md`（`gh pr edit` はしていない）

実機で確かめることは、上の「未確認」と `docs/PR-BODY.md` の「未確認」にある。

### XREVIEW 修正（2026-11-20）

Codex の独立レビュー（`XREVIEW-codex.md`）の指摘 12 件と提案を直した。回答の全文は `docs/REVIEW-NOTES.md` の「Codex レビュー（11/19）への回答」。Codex 対応に関わる点: hook の command のシェル引用（共通の `lib/shellquote.js`）、所有判定の完全一致、`--repo-skill` のリポジトリ外への配置・削除の防止、AGENTS.md と hooks.json の全か無かの書き込み、コミットの帰属（reflog と `git commit` の形）、project の `.codex/config.toml` の確認。実機で確かめることの一覧（上の「未確認」）は変わらない。

### XREVIEW 修正の続き（2026-11-20 09:xx JST）

残り: **CI の再実行だけ**。コードと文書の修正は終わり、ローカルで 180/180、各ノードの独立 reviewer は PASS。GitHub Actions が課金・支出上限でジョブを開始できず（`gh run view` の注記: "recent account payments have failed or your spending limit needs to be increased"）、57c4949・c3854af の Windows 修正（doctor の `GIT_CONFIG_GLOBAL` を空ファイルに、テストのパス区切り）が CI で未確認。手順: (1) Riku が Billing を解除、(2) `gh run rerun $(gh run list --branch feat/v0.1 --limit 1 --json databaseId -q '.[0].databaseId')`、(3) 失敗があれば `gh run view <id> --log` で直し、小さなコミットを push（force-push しない）、(4) 緑になったら PR 本文（docs/PR-BODY.md）の CI の行を更新し `gh pr edit 1 --body-file docs/PR-BODY.md`。PR は draft のまま、マージしない。

