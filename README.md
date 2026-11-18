# claude-verify-layer

Claude Code の「コミット前の検証」を**測る**ための、観察だけの層です（v0.1.0）。

- verify（と code-review）が実行されたか、そのあとのコミットが**検証した状態のままか**を、各リポジトリの `.git/claude-verify/ledger.jsonl` に記録する
- HEAD にコミット済みの `.claude/verification/checklist.json` を今回の diff に照合し、当たった項目だけを verify の開始時に Claude へ渡す
- `report` で内訳を、`doctor` で「標準の verify 指示が効く条件」と hook の配線を確かめる

作業は一切止めません（観察モード）。モデルも呼ばないので、常時かかる費用はありません。依存は Node 18 以上の標準機能と git だけです（npm の依存なし）。private のため LICENSE は付けていません。

導入は [INSTALL_FOR_CLAUDE.md](INSTALL_FOR_CLAUDE.md) を、導入先の Claude Code に読ませてください（検出 → 承認 → 導入 → 確認 → 削除の順で進みます）。設計の経緯は [docs/DESIGN-source.md](docs/DESIGN-source.md)（原本）と [docs/REVIEW-NOTES.md](docs/REVIEW-NOTES.md)（レビューと調整済み計画。**食い違いはこちらが優先**）にあります。

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
- 判定は、**コミットに含まれるファイル**について、直近の verify 開始時のツリーと HEAD の差を見ます。
  - `verified`: 差がない（検証した内容のままコミットされた）
  - `stale`: 差がある（verify のあとに変えた。差のあるファイルの数を残す）
  - `none`: 前のコミットのあとに verify の記録がない
  - `skipped`: ドキュメントとテストだけの変更（`skipGlobs`。標準の指示の対象外）。`none` より優先する。空のコミットも `skipped`
  - 記録したツリーが git から消えていて比べられないときは `stale`（`stale_files` が `null`、`warn: tree-unreachable`）
- 同じ `session_id` で verify / code-review があったか（`session_verify` / `session_code_review`）も残します。ツリー単位の判定とセッション単位の判定を並べて見るためです。
- `.claude/skills/verify/SKILL.md` は `/verify` 自身が書き換えるため、コミットに含まれなければ判定に影響しません。

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

評価 E1（縮小版: 実際のバグ由来の罠 4 件 ＋ 対照 4 件 × 3 プロファイル）の一式は [eval/](eval/README.md) にあります。**状態: 未実施**（準備と、モデルを呼ばない範囲の確認だけが済んでいる）。判定基準は結果を見る前に [eval/RESULTS.md](eval/RESULTS.md) に固定してあり、結果が出たらそこと、この欄に書きます。E2（レビュアーの再現率）は今回やりません（理由は eval/README.md）。実機スモークの記録は [docs/SMOKE.md](docs/SMOKE.md)。

実機スモークの現状（[docs/SMOKE.md](docs/SMOKE.md)）: 開発環境の `claude` が未ログインでモデルを呼べず、**台帳に行が出るかの実機確認は未実施**です。プラグインの読み込みと hook の認識（`plugin details`、`plugin validate`）だけを実機で確かめました。ログイン済みの端末での確認手順を同じ文書に載せています。

## 開発

```
node --test        # tests/ 以下。一時的な git リポジトリを作って試す。依存の取得は不要
node scripts/vl.js doctor
```

CI は ubuntu / macos / windows × Node 18 / 22（`.github/workflows/ci.yml`）。

```
.claude-plugin/      plugin.json と、ZIP を展開したディレクトリをマーケットプレイスにするための marketplace.json
hooks/hooks.json     プラグイン形式の hook 配線（exec 形式、Bash と PowerShell を別々に）
scripts/vl.js        入口（hook skill|commit|expand / report / doctor）
scripts/lib/         git・glob・ledger・classify・checklist・hooks・report・doctor・settings（標準機能だけ）
scripts/install.js   プラグインが使えない環境向けの settings.json マージ（--check / --apply / --uninstall）
rules/verification.md  Rules の 2 行
examples/checklist.json  チェックリストの雛形
tests/               node:test
docs/                設計書の原本、レビューノート、実機確認の記録（SMOKE.md）
```
