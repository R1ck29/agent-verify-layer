# agent-verify-layer

（旧名 claude-verify-layer。2026-11-18 に Codex 対応を見据えて改名。Claude Code のプラグイン名 `verify-layer` は変えていません。Codex 対応の計画とレビューは [docs/CODEX-SUPPORT-PLAN.md](docs/CODEX-SUPPORT-PLAN.md)）

Claude Code と Codex CLI 向けの検証レイヤーです。既定の v0.1 観察モードはコミット前の検証を記録します。v0.2 は、リポジトリで有効化すると依頼中の変更を隔離コピーで比較し、終了時に証拠を照合します。

## v0.2 の使い方

1. 利用するホストの開始・Stop hook を、導入先で登録します。下の例は Claude Code 用です。Codex CLI では `--agent claude` を `--agent codex` に替えます。確認だけなら `--apply` の代わりに `--check`、削除は `--uninstall` を使います。

   ```sh
   node /path/to/verify-layer/scripts/install.js --v02 --agent claude --apply
   node /path/to/verify-layer/scripts/install.js --v02 --agent claude --repo-skill --apply
   ```

2. 対象リポジトリで `node /path/to/verify-layer/scripts/vl.js verify-diff --generate-config` を実行します。公開テストの収集結果に基づいてランナーと保護パスを選ぶため、信頼できるリポジトリで実行してください。出力の `verifyV2` をリポジトリ直下の `.verify-layer.json` に保存します。

   ```json
   {
     "verifyV2": {
       "mode": "observe",
       "runner": "node",
       "protectedPaths": ["test/core.test.mjs"]
     }
   }
   ```

3. 新しい依頼を開始し、hook が返す依頼 ID とコマンドを使います。`verify2` の手順に沿って境界候補を 3〜5 件挙げ、最も誤りやすい 1 件を公開入口で確かめるテストを追加します。指定 assertion をテスト本体の直下に置き、ケース JSON の `input` に型付き実引数、`inputFiles` に前後で共通に使うデータを記入して `verify-diff --case <JSON>` を実行します。ケース JSON はリポジトリ外に置くと、ケースの編集で作業ツリーの ID が変わりません。テンプレートは [verify2 スキル](skills/verify2/SKILL.md) にあります。
4. 実装やテストを追加で編集したら、同じ最終状態で必要なケースを再実行します。`verify-diff --status` に hook から受け取った `--agent`、`--session`、`--request` を付けると状態を確認できます。

| モード | 終了時の動作 |
| --- | --- |
| `off` | v0.2 を無効にします。`verifyV2` または `mode` を省略した場合も同じです。 |
| `observe` | 判定を記録して終了を許可します。設定生成時の既定です。 |
| `enforce` | リポジトリ単位で明示的に選びます。未検証時に依頼ごとに最大 1 回、境界検証を求めます。対応外ランナー、ケース取り下げ、確認された仕様矛盾では該当理由を記録して終了を許可します。 |

異なるケース ID は 1 依頼で最大 3 件です。比較で失敗したケースは実引数、期待値、テスト、参照ファイルの状態が固定されます。期待値の誤りは `verify-diff --withdraw <caseId> --reason "<理由>"` で取り下げ、最終報告に理由を含めます。

Verify はローカルで動作し、モデル API を呼びません。v0.2 の介入は最大 1 追加ターンです。ランナーに渡す時間予算は `timeoutMs` で短縮でき、既定および上限は 30 秒です。隔離コピーの準備時間もホストの hook・試行時間に含まれます。評価時のターン数、実行時間、費用の上限は各プロファイルで揃えます。[設計 rev12 §6.4](docs/V02-DESIGN.md#64-費用上限実行順序定額プラン運用規則)

Linux で pytest、unittest、Node の公開テストを扱います。Node の追加ケースには `t.assert` とモジュールロード・入口の計測を使えるバージョンが必要です。ランナーをまたぐ構成や収集漏れは `unsupported` です。共有可変参照、対応する型付き値で表せない引数、参照の初期状態の不一致、子プロセスの参照を追跡できない場合は未検証になります。検証結果が示すのは選択した境界と既存公開テストで観測した動作です。[既知の限界 Issue #2](https://github.com/R1ck29/agent-verify-layer/issues/2)

実ホストでの発火・理由配送・再入は別途確認します。構造テストとホスト別の確認手順は [スモーク手順](docs/SMOKE.md#v02-の開始と-stop-の確認) を参照してください。

## v0.1 観察モード

以下は Claude Code と Codex CLI のコミット前検証を観察する v0.1 の手順です。Codex は 0.170 の文書に基づく対応です。

- verify（と code-review）が実行されたか、そのあとのコミットが**検証した状態のままか**を、各リポジトリの `.git/claude-verify/ledger.jsonl` に記録する
- HEAD にコミット済みの `.claude/verification/checklist.json` を今回の diff に照合し、当たった項目だけを verify の開始時に Claude へ渡す
- `report` で内訳を、`doctor` で「標準の verify 指示が効く条件」と hook の配線を確かめる

作業は一切止めません（観察モード）。モデルも呼ばないので、常時かかる費用はありません。依存は Node 18 以上の標準機能と git だけです（npm の依存なし）。private のため LICENSE は付けていません。

導入は [INSTALL_FOR_CLAUDE.md](INSTALL_FOR_CLAUDE.md) を、導入先の Claude Code（または Codex）に読ませてください（検出 → 承認 → 導入 → 確認 → 削除の順で進みます。Codex がない端末では Codex の部分を飛ばし、Claude だけ・Codex だけ・両方のどれでも入れられます）。設計の経緯は [docs/DESIGN-source.md](docs/DESIGN-source.md)（Riku の設計書の原本。**最上位**）と [docs/REVIEW-NOTES.md](docs/REVIEW-NOTES.md)（レビューと調整済み計画）にあります。REVIEW-NOTES が原本から変えた点（PostToolUse への移動、OTEL の廃止など）は変更案であり、承認されるまで原本が正です。独立レビュー（Codex）への回答は REVIEW-NOTES の「Codex レビュー（11/19）への回答」にあります。

## 何をするか・しないか

| する | しない |
| --- | --- |
| verify / code-review の実行と、成功した `git commit` を台帳に記録する | コミットを止める、拒否する、遅らせる（enforce は v0.1 にない） |
| コミットを verified / stale / none / skipped に分類する | verify が**通ったか**の判定（分かるのは「始めた時点のツリー」だけ） |
| HEAD 側のチェックリストを照合し、当たった項目を `additionalContext` で渡す | 作業ツリー側のチェックリストを読む |
| チェック自体（チェックリスト、CLAUDE.md、hooks、設定、`.claude/skills/verify/`）を触る変更に警告する | verify の中身・起動手順・レビュー本体の実装（同梱の `/verify`、`/run-skill-generator`、`/code-review` に任せる） |
| 件数・ハッシュ・ID・時刻だけを記録する | プロンプト、コマンド、`command_args`、ファイル名の記録。外部への送信（OTEL を含む） |
| `.claude/skills/verify/` を読むだけにとどめる | `.claude/skills/verify/` や個人用の場所に書く。`verify` という名前のスキルを配る |

## 仕組み

```
利用者 / Claude ──/verify──▶ PostToolUse(Skill) または UserPromptExpansion ──▶ vl.js hook skill|expand
                                   └─ 作業ツリーのハッシュ（一時インデックス）を記録 ＋ チェックリスト照合
Claude ──git commit──▶ PostToolUse(Bash|PowerShell, if: git commit *) ──▶ vl.js hook commit
                                   └─ HEAD を直近の verify の記録と比べて 1 行追記
```

- Skill の hook に `if` は付けません（実機の 2.1.325 で `if: "Skill(verify)"` が当たらなかったため。`docs/SMOKE.md`）。`matcher: "Skill"` の 1 本が全スキルの呼び出しで起動し、スクリプト側で `verify`（入れ子の `apps/web:verify` も）と `code-review`（別名 `review`）だけを記録して、ほかは何もせず終了します。Bash の `if` は実機で当たりました。
- 観察は **PostToolUse だけ**で行います。PreToolUse には載せません（ECC の gateguard などと並列に走って、拒否されたコミットの行が残るのを避けるため）。
- ツリーのハッシュは、本物の index を一時ファイルにコピーして `git add -A` → `git write-tree` で求めます（本物の index と `index.lock` には触れません）。
- 判定は設計書の原本どおり、**作業ツリーのハッシュ**で行います（コミット直後の作業ツリーのハッシュと、直近の verify の記録のハッシュを比べる）。
  - `verified`: 一致する（verify の記録のあと、作業ツリーに 1 文字の変更もない）
  - `stale`: 一致しない。コミットに含まれるファイルについて、記録したツリーとの差のあるファイルの数を `stale_files` に残す
  - `none`: 前のコミットのあとに verify の記録がない
  - `skipped`: ドキュメントとテストだけの変更（`skipGlobs`。標準の指示の対象外）。`none` より優先する。空のコミットも `skipped`
  - `unknown`: git が変更ファイルやスナップショットを返せなかった（`skipped` や正常な tree とは区別して数え、検証率の分母に入れない）
  - 記録したツリーが git から消えていて比べられないときは `stale`（`stale_files` が `null`、`warn: tree-unreachable`）
  - 別集計として、`paths_match`（コミットしたファイルは検証時と同一か）と `head_tree_match`（コミットの tree 全体が検証した tree か）を残す。**`verified` はコミット内容が検証されたことではなく、作業ツリーが検証済みだったこと**を意味する。互いに依存する変更の部分コミットは `verified` でも `head_tree_match: false` になり、`report` に別掲される
- 同じ `session_id` で verify / code-review があったか（`session_verify` / `session_code_review`）も残します。ツリー単位の判定とセッション単位の判定を並べて見るためです。
- `.claude/skills/verify/SKILL.md` は `/verify` 自身が書き換えるため、verify の最中に作業ツリーが変わり `stale` になり得ます（`paths_match` で見分けられます）。確認が終わった時点で `mark verify` を実行すると、その時点のツリーが記録されます。
- コミットの記録は、コマンド本文に本物の `git commit`（`--dry-run` でない。`-C`・`cd` で場所が特定できる）があり、HEAD の reflog の最新が直近の `commit…` で、SHA が未記録のときだけ行います。特定できない形（`--git-dir`、`cd $VAR`、`bash -c`、alias）は拾えず、`report` の突き合わせで「台帳にない」に数えます。同じ SHA は並行する hook からも 1 行だけ記録します（台帳のロック）。

## Codex

Codex CLI（0.170 の文書。`../sources/codex/`）向けの部分です。台帳・判定・チェックリスト・`report` は Claude と共通で、行に `agent: "codex"` が付きます。

| 部品 | Codex での形 |
| --- | --- |
| コミットの記録 | `$CODEX_HOME/hooks.json` の PostToolUse `^Bash$` に 1 本（`node "<絶対パス>/vl.js" hook commit --agent codex`、`timeout: 10`）。Codex の hook には `if` がないので、`git … commit` を含まないコマンドはスクリプトの先頭で即終了する。`install.js --agent codex` がマージする（既定は確認だけ、冪等、他の hook は変えない） |
| verify の起点 | Codex には「コミット前に verify を使う」標準の指示がないため、AGENTS.md に 2 行（`$verify` を使う／確認が通ったら `vl.js mark verify --agent codex`）を `--agents-md` で追記する |
| verify スキル | `codex/skills/verify/SKILL.md` を、承認のうえで各リポジトリの `.agents/skills/verify/` に写す（`--repo-skill`）。確認の手順は持たず、Claude の `/verify` が記録した `.claude/skills/verify/SKILL.md` に従う（手順は 1 か所） |
| 記録の時点 | `mark verify` が「確認が終わった時点」のツリーを記録し、その時点の diff に当たるチェックリストの項目を出す（Codex には Skill の hook がないため、チェックリストを渡す経路はここ） |
| hook の信頼 | Codex は `/hooks` で利用者が信頼するまで hook を動かさない。`doctor` は信頼の状態を読めないので、確認の手順を案内する |
| doctor | 版、`features.hooks`、`allow_managed_hooks_only`、hook の配線と重複、プロジェクトの信頼、`.agents/skills/verify`、個人用の verify、AGENTS.md の 2 行。Codex がなければ 1 行の案内だけ |
| レビュアー | Codex の `/review`。会話内のコマンドで hook にならないため、初版は記録しない |

未確認（実機で確かめること）は [docs/CODEX-SUPPORT-PLAN.md](docs/CODEX-SUPPORT-PLAN.md) の「未確認」にあります。

## 台帳の読み方

`git rev-parse --git-path claude-verify` の下の `ledger.jsonl`（1 行 1 JSON、`ts` は epoch 秒）。linked worktree では worktree ごとに別になります。

```json
{"v":1,"kind":"run","ts":1794981429.442,"skill":"verify","via":"model","tree":"80d5b3e6…","session":"s1","fired":["hooks-stdout"],"self_check_change":true,"ms":22}
{"v":1,"kind":"commit","ts":1794981429.504,"sha":"19999b8d…","mode":"observe","result":"verified","stale_files":0,"since_run_s":0,"session_verify":true,"session_code_review":false,"n_files":1,"self_check_change":false,"session":"s1","ms":15}
```

| 行 | 主な項目 |
| --- | --- |
| `run` | `skill`（verify / code-review）、`via`（model: Claude が呼んだ / user: 利用者が打った）、`tree`（開始時のツリー）、`fired`（当たったチェックリスト項目の id。刈り込みの分母になる）、`self_check_change`、`checklist_warnings`（不正な項目の数） |
| `commit` | `sha`、`result`、`stale_files`、`since_run_s`、`session_verify`、`session_code_review`、`n_files`、`self_check_change`、`ms` |

`node scripts/vl.js report [--json] [--days N] [--repo DIR]` で次を出します: 結果の内訳、verified 率（skipped を除く）、verify の実行率、stale の大きさ、チェックリスト項目の発火数、hook の p50/p95、`git log` との突き合わせ（台帳に拾えたコミットの割合）。`if` はベストエフォートなので、`git -C`、スクリプト経由、利用者の `!` コマンド、Claude 以外のコミットは台帳に載りません。突き合わせは**推定**です。

## チェックリスト

`.claude/verification/checklist.json`（雛形は [examples/checklist.json](examples/checklist.json)）。YAML ではなく JSON にしたのは、標準機能だけで読むためです。

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| `id` | ○ | 台帳の `fired` に残る名前 |
| `paths` | ○ | glob（`**`、`*`、`?`、`{a,b}`。`/` を含まなければ任意の深さのファイル名に当たる） |
| `pattern` |  | 追加された行に当てる正規表現（未追跡ファイルは中身の全行） |
| `check` | ○ | 確認すること（1 文） |
| `why` | ○ | なぜ確認するか（Claude にも渡す） |
| `owner` | ○ | そのコードの持ち主。持ち主が、指摘したい点を指摘できるまで磨く |
| `incident` |  | 元になった不具合や PR |

- **HEAD 側だけを読みます**（`git show HEAD:.claude/verification/checklist.json`）。変更が、自分を判定するチェックを書き換えられないようにするためです。ただし、直接コミットでは 1 つ前のコミットで書き換えれば次のコミットはそれで判定されます。そのため、チェック自体を触る変更には必ず警告を添え、台帳に `self_check_change` を残します。人が見てください。
- 不正な項目・壊れた JSON・不正な正規表現は黙って捨て、件数だけを台帳に残します。当たりがなければ何も出さないので、トークンは増えません。
- `/code-review` のレビュアーには渡せません（CLAUDE.md しか読まないため）。レビュアーに重視してほしい点は CLAUDE.md の短い節に書きます。

## 既存のハーネスとの違い

- **wikiskill / agent eval**: 役割が違います。wikiskill は業務の例からスキルを育て、agent eval は変更の with / without を採点します。この層は、日々のコミットで verify が行われたかを測る記録係です。agent eval は、この層を配ってよいかを採点するときに使います（評価の設計は REVIEW-NOTES 5.6）。
- **ECC の gateguard**: 同じ PreToolUse で deny する別物です。この層は PostToolUse だけなので並列に動いても衝突しません。enforce を作るときは、自分の deny だけを数えます。
- **ECC の skill-run-tracker**: Skill の実行を記録しますが、ツリーのハッシュを持ちません。目的（コミットとの照合）が違うので統合していません。
- **hookify**: 作業ツリー側の規則を読むため、「変更が自分のチェックを変えられない」を満たしません。
- **GitHub の管理型 Code Review（REVIEW.md）**: この環境からは GitHub に届かないため使えません。「ベースから読む」原則だけを、この層が自前で持ちます。

## 設計書からの主な変更（詳細は REVIEW-NOTES 第 5 節）

観察は PostToolUse の成功したコミットだけにした／`Bash|PowerShell` と `if` を 2 本に分けた（Git Bash のない Windows 対応）／判定を「コミットに含まれるファイルの差」にした／`/code-review` の実行も記録／OTEL テレメトリをやめてローカルの `report` にした／SQL 向けの個人用 verify を外した／チェックリストを JSON にして `owner`・`why` を必須にした／Rules は 2 行（「2 回目は Opus」は落とした）。

## 既知の限界

- 記録されるのは「verify を始めた時点のツリー」です。終わったか、通ったかは分かりません（verify 中に直したコミットは stale に、失敗した verify のあとでも verified になりえます）。enforce の前に、観察の結果を 20 件ほど人が見てください。
- コミット前の verify 指示は、Claude Code 2.1.286 以降の標準機能と、バイナリ内のフラグ（既定は on）に依存します。版が上がると変わりえます。`doctor` は文書にある条件だけを確かめます。verify の実行率が急に落ちたら、まず版の変化を疑ってください。
- `/code-review` は背景で動くため、指摘が届く前にコミットが進みえます。前景で動かすには `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`（ほかの背景機能も止まるので既定にはしません）。
- 台帳は各端末の `.git` の中だけにあり、チーム全体では引けません。
- `UserPromptExpansion` を追加した版は changelog にありません。導入先の 2.1.321 で発火するかは、導入時の確認で見てください。発火しなければ、利用者が打った `/verify` は記録されず `none` が増えます。
- Windows は手元で実機確認できていません。単体テスト（`path.win32`）と CI（windows-latest）で補っています。

## 評価結果

評価 E1b（実リポジトリの罠）の結果は下の「E1b」を先に読んでください。評価 E1（縮小版: 実際のバグ由来の罠 4 件 ＋ 対照 4 件 × 3 プロファイル × 2 回 = 48 試行、sonnet）の一式は [eval/](eval/README.md) にあります。**結果（2026-11-18）: 判定不能**。P0（層なし）が罠 8/8 で天井だったため、層の効果を測れていません。隠しテストの合格は、罠が P0 8/8・P1（CLAUDE.md にルール）8/8・P2（この層）6/8、対照はどれも 8/8。P2 の不合格 2 件は `trap-drift-scope`（2 回とも verify を呼ばず直接実行）。台帳は 16 コミットすべてを拾い、結果の合致は 13/16（偽の stale 2）でした。この評価は、有用とも有用でないとも言えません。判定基準は結果を見る前に固定してあり、数値・限界・次の版は [eval/RESULTS.md](eval/RESULTS.md)、集計は `eval/tools/aggregate.py`。E2（レビュアーの再現率）は今回やりません（理由は eval/README.md）。実機スモークの記録は [docs/SMOKE.md](docs/SMOKE.md)。

### E1b（2026-11-19、[eval/RESULTS-E1b.md](eval/RESULTS-E1b.md)、ブランチ feat/e1b-hard）

事前に固定した規則による判定は、Claude 側で **「有用でない」**: 罠の合格が P0（層なし）9/12・P1（CLAUDE.md にルール）10/12・P2（この層）9/12、対照は 8/8。P2 は P0 を上回らず（改善 1・後退 1）、4/12 でしか verify を呼びませんでした。Codex 側は各セル 1 試行の予備結果で、判定はまだ出していません。したがって **v0.1 の層は、この評価では効果を示せていません**。観察の台帳としては動きます。改善版 v0.2 は feat/v0.2 で設計中で、held-out の罠で決定評価する予定です。

実機スモークの現状（[docs/SMOKE.md](docs/SMOKE.md)。11/18 に Claude Code 2.1.325 で実行）:

- **Claude で確認済み**: `Skill` の hook（`if` なしの 1 本）が実機で当たり、run 行（`via: model`）ができること、`Bash(git commit *)` の `if` と commit 行の書き込み、`report` の突き合わせ、`stale` の出方（verify を編集前に読み込むと偽の stale になる → `mark verify` で対処）
- **未確認**: `UserPromptExpansion`（利用者が打った `/verify`）、PowerShell の `if`、Windows の実機、Codex の実際の PostToolUse（`tests/` の Codex 入力は文書から作った fixture で、実機で採取したものではない）、導入先の Claude Code 2.1.321 での動作

## 開発

```
node --test        # tests/ 以下。一時的な git リポジトリを作って試す。依存の取得は不要
node scripts/vl.js doctor
```

CI は ubuntu / macos / windows × Node 18 / 22（`.github/workflows/ci.yml`）。

```
.claude-plugin/      plugin.json と、ZIP を展開したディレクトリをマーケットプレイスにするための marketplace.json
hooks/hooks.json     プラグイン形式の hook 配線（exec 形式、Bash と PowerShell を別々に）
scripts/vl.js        入口（hook skill|commit|expand / mark verify / report / doctor）
scripts/lib/         git・glob・ledger・classify・checklist・hooks・report・doctor・settings（標準機能だけ）
scripts/install.js   プラグインが使えない環境向けの settings.json マージ（--check / --apply / --uninstall）。--agent codex で Codex の hooks.json・AGENTS.md・リポジトリのスキル
codex/skills/verify/ Codex 用の verify スキルの雛形（Claude のプラグインのスキルではない）
rules/verification.md  Rules の 2 行
examples/checklist.json  チェックリストの雛形
tests/               node:test
docs/                設計書の原本、レビューノート、実機確認の記録（SMOKE.md）
```
