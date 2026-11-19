# INSTALL_FOR_CLAUDE.md — agent-verify-layer の導入手順（Claude Code と Codex）

この文書は、ZIP を展開した利用者のマシンで動いているエージェント（あなた。Claude Code か Codex）が読み、実行するための手順書です。順番どおりに進めてください。**書き込みは、利用者の承認を得てからです。** それまでは読むだけにします。ファイル名は互換のため据え置いています。

- Claude の部分は第 1〜8 節、Codex の部分は第 9 節です。どちらか一方だけ入れることも、両方入れることもできます（第 3 節の「部分的に入れる」）。台帳・設定（`~/.claude/verify-layer/config.json`）・`report` は両方で共通です
- **Codex がない端末では第 9 節を飛ばします**（`codex --version` が失敗し、`$CODEX_HOME`（既定 `~/.codex`）もないとき）。Claude Code がない端末では、第 1 節の Node・git・OS の行だけを調べて第 9 節へ進みます
- あなたが Codex なら、`claude` コマンドは使わず、第 1 節の共通の行と第 9 節に従ってください

## 0. これは何か（先に利用者へ 1 段落で伝える）

agent-verify-layer（旧名 claude-verify-layer）は、コミットが「verify を実行したあとの状態」でされたかを、各リポジトリの `.git/claude-verify/ledger.jsonl` に**記録するだけ**の仕組みです（観察モード。Claude Code と Codex に対応）。作業は止めません。プロンプト、コマンド、ファイル名は記録しません。台帳はその端末の中にしか残らず、外には送りません。もう 1 つの機能は、HEAD にコミット済みの `.claude/verification/checklist.json` を今回の diff に照合し、当たった項目だけを verify の開始時に Claude へ渡すことです（モデルは呼びません）。

役割の違い: wikiskill は「業務の例からスキルを育てる」仕組み、agent eval は「ハーネスの変更が効いたかを with / without で採点する」仕組みです。この検証レイヤーは、日々のコミットで verify が実際に行われたかを**測る**ための記録係で、どちらとも置き換えにはなりません。agent eval は、この層を配ってよいかを後で採点するときに使います（v0.1 には含みません）。

## 1. 環境を検出する（読むだけ。何も書かない）

次を順に調べ、結果をメモします。コマンドが失敗したら「不明」と記録して先へ進みます。`<展開先>` は、この文書があるディレクトリです。

| 調べること | 方法 | 結果の意味 |
| --- | --- | --- |
| Claude Code の版 | `claude --version` | **2.1.286 未満**: コミット前に verify を実行する標準の指示が入らないので、verify の実行率は 0 になる（台帳は入る）。**2.1.295 未満**: hook の `onFailure` を解釈しない。`if` は 2.1.85、exec 形式は 2.1.139 以上が必要 |
| OS | `uname -s`（Windows は `$PSVersionTable.OS` か `ver`） | macOS / Linux / Windows のどれか |
| Windows の Git Bash と PowerShell | `where bash`、`Get-Command pwsh, powershell`、環境変数 `CLAUDE_CODE_GIT_BASH_PATH`、`CLAUDE_CODE_USE_POWERSHELL_TOOL` | Git Bash がないと Bash ツールが登録されない。PowerShell ツールが有効だと主シェルは PowerShell になる。hook は `Bash\|PowerShell` の両方に配線済みなので、どちらでも動く |
| Node | `node --version`（18 以上が必要）。Windows は `where node` | なければ第 6 節へ |
| git | `git --version`（2.30 以上を推奨） | なければ導入できない |
| 推論の経路 | 環境変数 `CLAUDE_CODE_USE_BEDROCK` など | その推論経路ではフラグを取りに行かないため、標準の verify 指示は既定値に従う |
| GitHub に届くか | 利用者に聞く。確かめるなら、認証を求められない公開の URL に `GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/git/git HEAD`（5 秒で打ち切る） | 届かなくても、ZIP をローカルのマーケットプレイスとして使えば導入できる |
| 管理設定 | macOS `/Library/Application Support/ClaudeCode/managed-settings.json`、Linux `/etc/claude-code/managed-settings.json`、Windows `C:\Program Files\ClaudeCode\managed-settings.json`。キーは `allowManagedHooksOnly`、`strictPluginOnlyCustomization`、`disableAllHooks`、`includeGitInstructions`、`skillOverrides`、`enabledPlugins` | 第 3 節で使う。サーバー管理の設定は、ファイルでは見えない。`/status` の `Setting sources` で管理元を確かめ、`/hooks` に「管理設定の hook だけが動く」旨が出ていないかも見る |
| 利用者・プロジェクトの settings | `~/.claude/settings.json`、`<repo>/.claude/settings.json`、`<repo>/.claude/settings.local.json`。同じキーに加え、`env` の `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`、既存の `hooks` | 既存の hook は壊さない。特に PreToolUse と PostToolUse の `Bash`、`Skill`、`UserPromptExpansion` を数えて報告する（件数だけでよい） |
| 同名のスキル | `~/.claude/skills/verify`、`~/.claude/skills/simplify`、`~/.claude/commands/verify.md`、管理設定ディレクトリの `.claude/skills/verify` | 個人用・エンタープライズの `verify` は、全リポジトリのリポジトリ側の記録を上書きする。見つけたら利用者に伝える（消すのは提案だけ） |
| `verify` が標準の指示の対象か | 環境変数 `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`、設定 `includeGitInstructions: false`、`skillOverrides` の `verify` / `simplify` が `user-invocable-only` か `off`、プロジェクトの `verify` の `disable-model-invocation: true`、`--bare` / `--safe-mode` の使用 | どれかに当たると標準の指示が消え、verify の実行率は 0 になる |
| コミットに反応する既存 hook | ECC の gateguard など（PreToolUse の Bash）。settings と有効なプラグインを見る | 同じイベントの hook は並列に動く。この層は PostToolUse だけなので衝突しない。ほかを無効にするのは提案にとどめる |
| Codex | `codex --version`、`$CODEX_HOME`（未設定なら `~/.codex`）があるか | どちらもなければ Codex の部分（第 9 節）は飛ばす。あれば第 9 節の検出も行う |
| プラグイン配布 | 利用者に聞く。`claude plugin marketplace list` も見る | あれば、配布担当に ZIP の内容を導入先のマーケットプレイスへ登録してもらうのが最も確実 |

そのあと `node <展開先>/scripts/vl.js doctor`（読むだけ。使い捨てのリポジトリで hook を試し、利用者のリポジトリや設定には書かない）を実行し、出力を結果に加えます。

## 2. 結果と導入案を利用者に見せ、承認を得る

次の形で報告し、**承認の返事を待ちます。** 承認のない書き込みはしません。

1. 検出した環境の要約（版、OS、Node、経路、管理設定、既存の hook の件数、同名のスキル）
2. 使えない・効かない機能（例: 「2.1.286 未満なので verify の実行率は 0 になります」）
3. 選んだ経路と、書き込む場所と内容（第 3 節）
4. 書き込む前に `--check` で見せる差分、取るバックアップ、元に戻す方法（第 7 節）
5. 第 5 節の 2 と 3（使い捨てリポジトリでのモデル実行、各リポジトリでの `SKILL.md` のコミット）は**別々の承認**にする。導入の承認に含めない
6. Codex がある端末では、Claude の部分と Codex の部分（第 9 節）を**別々に**承認してもらう。どちらか一方だけでもよい

## 3. 経路の選び方

| 条件 | 経路 |
| --- | --- |
| 管理設定に `allowManagedHooksOnly: true` | **自分では入れない。** 管理者向けの断片を出力して終える。経路は 2 つあり、どちらかを選んでもらう: (1) このプラグインを導入先のマーケットプレイスに登録し、管理設定の `enabledPlugins` で強制有効にする（強制有効のプラグインの hook だけが動く。置き換えは要らない）、(2) `hooks/hooks.json` の内容を管理設定の `hooks` に直接入れる（`${CLAUDE_PLUGIN_ROOT}` を、全端末で同じ配置先の絶対パスに置き換える） |
| プラグインが使える（導入先のマーケットプレイス、またはローカルのマーケットプレイスが許可されている） | **A: プラグインとして入れる** |
| プラグインが使えない、または管理設定がプラグインを止めている | **B: settings.json にマージする**（`scripts/install.js`） |
| `strictPluginOnlyCustomization` が skills を含む | 導入はできるが、プロジェクトの `verify` が読み込まれないので verify の実行率は 0 になる、と伝える |
| `strictPluginOnlyCustomization` が hooks を含む、または `disableAllHooks: true` | **B（settings マージ）は選ばない。** settings に書いた hook は動かない。A（プラグイン）だけを提案する。それも止まっているなら、書き込まずに理由を伝えて終える |
| Node がない | 第 6 節。導入しない |

### 部分的に入れる

導入先の環境や方針に合わせて、次の単位で選べます。「要るもの」を満たしていれば、どの単位もあとから足せます。Claude と Codex は互いに独立で、Codex のリポジトリのスキルは利用者全体の hook や AGENTS.md に触れません（hook がなくても置けます）。

| 単位 | 入れるもの | 効果 | 要るもの |
| --- | --- | --- | --- |
| Claude: 記録 | 第 4 節の A か B | Claude のコミットと verify を記録する | Claude Code、Node、git |
| Claude: Rules | `--rules`（または `rules/verification.md` のコピー） | 検証の規則を 2 行足す（flaky なテストを skip や再実行で済ませない、verify が 3 回続けて失敗したら止めて報告する） | Claude: 記録 |
| Codex: 記録 | 第 9 節の `--agent codex --apply` | Codex のコミットを記録する | Codex、Node、git、`/hooks` での信頼 |
| Codex: 指示 | 第 9 節の `--agents-md` | AGENTS.md に 2 行（`$verify` を使う、確認後に mark する） | Codex: 記録 |
| Codex: リポジトリのスキル | 第 9 節の `--repo-skill`（リポジトリごと） | `.agents/skills/verify/` に verify スキルを置く | 利用者の承認（コミットするかは利用者が決める） |

## 4. 導入する（承認後）

### A: プラグインとして

展開したディレクトリ（`.claude-plugin/marketplace.json` があるところ）を、ローカルのマーケットプレイスとして追加します。GitHub には届かなくてかまいません。

```
claude plugin marketplace add <展開先>
claude plugin install verify-layer@verify-layer-local
```

導入先のマーケットプレイスに登録済みなら、`claude plugin install verify-layer@<導入先のマーケットプレイス名>` を使います。入れたあとは Claude Code を再起動してもらいます。

プラグイン経路では settings.json に hook を書かないので、`install.js` は使いません。観察モードは既定なので、設定ファイルは作らなくても動きます。明示したいときだけ `~/.claude/verify-layer/config.json` を `{"mode":"observe"}` で作ります（`mode` は `observe` か `off`。`off` の間は何も書きません）。Rules（2 行）を入れるなら、`rules/verification.md` を `~/.claude/rules/` にコピーします（既存の Rules のファイルは編集しません）。

### B: settings.json にマージする

まず読むだけで確かめ、差分を利用者に見せます。

```
node <展開先>/scripts/install.js --check                  # 利用者全体（~/.claude/settings.json）
node <展開先>/scripts/install.js --check --scope project  # このリポジトリだけ（.claude/settings.local.json）
```

承認を得たら適用します。

```
node <展開先>/scripts/install.js --apply --rules
```

- JSON として読んで書きます（文字列の置換はしません）。読めない JSON なら何も書かずに止まります（コメント付きの JSON も止まります）。
- 自分の hook は、`vl.js` の絶対パスを持つ exec 形式の handler だけで見分けます。2 回実行しても結果は同じで、パスが古ければ置き換えます。他の hook の削除・並べ替え・書き換えはしません。
- 書き込む前に `settings.json.verify-layer-backup-<日時>` を作ります。書き込めないファイルや、管理設定が hook を止めているときは、何も書かずに止まります。
- `--scope project` は、絶対パスが端末ごとに違うため、コミットされない `.claude/settings.local.json` に書きます。対象リポジトリの中で実行してください（外ではカレントディレクトリが対象になります）。
- `node` が Claude Code の PATH にない（nvm など）ときは `--node <node の絶対パス>` を付けます。
- `--rules` は `rules/verification.md` を `~/.claude/rules/` に置きます（`--scope project` のときは `<repo>/.claude/rules/` で、こちらは git の管理下に入る。コミットするかは利用者が決める）。既存の別内容のファイルは上書きしません。
- 観察モードの設定 `~/.claude/verify-layer/config.json` を `{"mode":"observe"}` で作ります。

## 5. 導入後の確認

1. `node <展開先>/scripts/vl.js doctor` — 各 hook に擬似入力を流し、終了コード 0 と出力の形を確かめます。NG があれば直し方を利用者に伝えます。WARN は内容を読んで報告します。
2. 任意（モデル費用は 1 回分）: 使い捨てのリポジトリで Claude Code を 1 回動かし、利用者に `/verify` を打ってもらい（同梱の `/verify` は利用者が打つコマンドで、あなたからは呼べません）、そのあとコミットさせ、`node <展開先>/scripts/vl.js report` で run と commit の行が増えたことを確かめます。`/verify` を打った記録（UserPromptExpansion）は、導入先の Claude Code の版によって発火しないことがあります。動かない場合は PostToolUse(Skill) だけで記録され、`none` が増えます。そのことを報告します。
3. 各リポジトリへの導入（リポジトリごとに 1 回）: 利用者に `/verify` を 1 回打ってもらい、記録された `.claude/skills/verify/SKILL.md` を（利用者の承認のうえで）コミットします。続けてもう 2 回 `/verify` を打ってもらい、結果が同じかを見ます。**`.claude/skills/verify/` には自分で書きません**（`/verify` が自分の記録として使う場所です）。
4. 使い方: `node <展開先>/scripts/vl.js report` で、台帳に拾えた割合、結果の内訳、verify の実行率、hook の所要時間を見ます。

## 6. Node がない場合

hook は `command: "node"` の exec 形式で動くので、Node がないと**起動せず、黙って素通りします**（`onFailure: "continue"` のため作業は止まらず、台帳も空のままです）。そのため、Node がない端末には導入しません。

1. 利用者に「Node 18 以上が入っていないため導入しません。入れてよいか」を伝える。Node のインストールは利用者の承認を得てからにし、自分では入れません
2. 入れた場合は、第 1 節の検出からやり直す
3. 入れない場合は、何も書かずに終える

## 7. アンインストール

承認を得てから、次の順で行います。

1. プラグイン経路: `claude plugin uninstall verify-layer@<マーケットプレイス名>`、続けて `claude plugin marketplace remove verify-layer-local`
2. settings 経路: `node <展開先>/scripts/install.js --uninstall --rules`（自分の hook だけを外します。ほかの設定は意味として元のままです。`--scope project` で入れたなら同じ指定を付けます。外した結果 settings が空の `{}` になるときは、そのファイルを消します。バックアップは残ります）
3. 設定も消すなら `--purge` を付けます（`~/.claude/verify-layer/` を消します）。プラグイン経路で手作業の `config.json` や Rules のコピーを作った場合も、`install.js --uninstall --rules --purge` で消せます（settings に自分の hook がなければ settings は書き換えません）
4. 各リポジトリの台帳 `.git/claude-verify/` は、消すかどうかを利用者に聞く。勝手に消さない
5. バックアップ（`settings.json.verify-layer-backup-*`）から丸ごと戻すことはしない（導入後に、ほかの変更が入っているかもしれないため）。必要なら差分を見せて利用者に決めてもらう

## 8. してはいけないこと

（Codex に固有のものは第 9 節の最後にあります）

- `.claude/skills/verify/` に書く。個人用の場所（`~/.claude/skills/verify`）に `verify` を置く
- プロンプト、コマンド、コマンドの引数、ファイル名を台帳に書く
- 利用者の承認なしに設定やファイルを書く。承認前に実行してよいのは `--check`、`doctor`、`report` だけ
- 他の hook を削除・無効化・並べ替える。ECC などを無効にするのは提案にとどめる
- 管理設定を書き換える。管理設定が hook を止めているときは、管理者向けの断片を出して終える
- GitHub に届かない環境で、`code-review@claude-plugins-official` を配る（`gh pr` 専用で、同梱の `/code-review` と名前が紛らわしい）
- `enforce`（コミットを止める動き）を有効にする。v0.1 にはありません

## 9. Codex の部分

Codex がない端末では、この節を飛ばします（利用者には「Codex が見つからないので Claude の部分だけ入れます」と 1 行伝える）。根拠の文書は Codex CLI 0.170 のもので、これより古い版では動きを確かめていません。

### 9.1 検出（読むだけ）

| 調べること | 方法 | 結果の意味 |
| --- | --- | --- |
| Codex の版 | `codex --version` | 0.170 より前なら、hook の入出力が文書と違い記録が動かない可能性がある。そのことを伝え、Codex の部分を入れるかを利用者に決めてもらう |
| Codex のホーム | `$CODEX_HOME`（未設定なら `~/.codex`） | hook はここの `hooks.json` にマージする |
| hooks が有効か | `$CODEX_HOME/config.toml` と管理者の `requirements.toml` の `[features] hooks`（旧名 `codex_hooks`） | `false` なら hook は動かない。入れても記録されないと伝える |
| 管理された hook だけか | `requirements.toml` の `allow_managed_hooks_only = true` | **自分では入れない。** 管理者に `requirements.toml` の `[hooks]` で配ってもらう（コマンドは `install.js --agent codex --check` の出力にある） |
| 既存の hook | `$CODEX_HOME/hooks.json`、`config.toml` の `[hooks]`、`<repo>/.codex/hooks.json` | 他の hook は変えない。この層は PostToolUse `^Bash$` の 1 本だけを足す。同じ hook が 2 か所にあると 2 回走る |
| 指示のファイル | `$CODEX_HOME/AGENTS.override.md`（空でなければこちらだけが読まれる）、なければ `$CODEX_HOME/AGENTS.md` と大きさ | 追記先。32 KiB を超えると末尾が読まれないことがある |
| 個人用の verify | `~/.agents/skills/verify` | あれば利用者に伝える（リポジトリの verify と両方が一覧に出る） |

まとめて `node <展開先>/scripts/vl.js doctor` でも確かめられます（Codex がなければ 1 行の案内だけになります）。

### 9.2 導入する（承認後）

まず読むだけで差分を見せます。

```
node <展開先>/scripts/install.js --agent codex --check --agents-md
```

承認を得たら適用します（`--agents-md` は「Codex: 指示」を入れるときだけ）。

```
node <展開先>/scripts/install.js --agent codex --apply --agents-md
```

- `$CODEX_HOME/hooks.json` を JSON として読み、自分の hook（`node "<絶対パス>/vl.js" hook commit --agent codex`、`timeout: 10`）だけを足します。2 回実行しても同じ結果です。読めない JSON なら何も書かずに止まります。書き込む前にバックアップを取ります
- `--agents-md` は、AGENTS.md（空でない `AGENTS.override.md` があればそちら）の末尾に 2 行を足します。既存の行は変えません
- `node` が Codex の PATH にないときは `--node <node の絶対パス>` を付けます
- `--scope project`（`.codex/hooks.json`）は使えません。端末ごとの絶対パスをコミットすることになるためです

**hook の信頼**: Codex は、利用者が信頼するまで hook を実行しません。利用者に Codex を起動して `/hooks` を開いてもらい、verify-layer の hook（PostToolUse `^Bash$`）を確認して信頼してもらいます。hook の定義（`command` の文字列など）が変わると再び確認が要ります。同じ展開先で入れ直しても定義は変わりませんが、展開先を移したり `--node` を変えたりすると変わります。`--dangerously-bypass-hook-trust` は使いません。

### 9.3 リポジトリごとの verify スキル（任意。別の承認）

Codex には「コミット前に verify を使う」標準の指示がないため、AGENTS.md の 2 行と、各リポジトリの `.agents/skills/verify/SKILL.md` で補います。このスキルは確認の手順を持たず、Claude の `/verify` が記録した `.claude/skills/verify/SKILL.md` に従います（手順は 1 か所）。対象のリポジトリの中で、まず確認だけをします。

```
node <展開先>/scripts/install.js --agent codex --repo-skill
```

承認を得たら `--apply --repo-skill` で写します。この操作は `.agents/skills/verify/` だけを扱い、`hooks.json` と AGENTS.md は変更しません（`--agents-md` と同時には使えません）。既にある `.agents/skills/verify/` は上書きしません。写したファイルをコミットするかは利用者が決めます。

### 9.4 導入後の確認

1. `node <展開先>/scripts/vl.js doctor` の `Codex:` で始まる行を読み、NG・WARN を報告する
2. 任意（モデル費用は 1 回分。別の承認）: 使い捨てのリポジトリで Codex に小さな変更をコミットさせ、`node <展開先>/scripts/vl.js report` で `agent: codex` の commit 行が増えたかを見る。増えなければ、まず `/hooks` の信頼を確かめる

### 9.5 アンインストール

```
node <展開先>/scripts/install.js --agent codex --uninstall --agents-md
node <展開先>/scripts/install.js --agent codex --uninstall --repo-skill   # 各リポジトリで。スキルだけを外す。雛形から変えたものは残す
```

自分の hook と 2 行だけを外します。外した結果 `hooks.json` が空になるときはファイルを消します（バックアップは残ります）。台帳は Claude の部分と共通なので、消すかは利用者に聞きます。

### 9.6 Codex でしてはいけないこと

- `requirements.toml` や `config.toml` を書き換える（hooks を有効にするのも利用者か管理者の判断）
- `<repo>/.codex/hooks.json` や `config.toml` の `[hooks]` にも同じ hook を書く（2 回走る）
- `~/.agents/skills/verify` に個人用の verify を置く。`.claude/skills/verify/` に書く
- `--dangerously-bypass-hook-trust` で信頼の確認を飛ばす
