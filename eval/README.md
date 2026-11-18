# agent-verify-layer の評価（Claude 側）（E1 縮小版）

[agent-harness-eval](https://github.com/R1ck29/agent-harness-eval)（AHE 0.8.0）で、この層の「あり／なし」を比べるための一式です。ルール: 新しい部品は AHE で比べ、有用と示せたときだけ配備する。結果は [RESULTS.md](RESULTS.md)（**判定基準は結果を見る前に固定して**そこにあります）。AHE 本体は変更していません。

## 何を比べるか

| プロファイル | 内容 |
| --- | --- |
| P0 `claude-baseline` | 層なし。fixture の `.claude/verification/checklist.json` は HEAD にあるが、何も読ませない |
| P1 `claude-static-rules` | 層なし。ただし同じチェックリストの**全項目**を、常時読み込まれる `CLAUDE.md` に書く（「CLAUDE.md にルールを書くだけで足りるのでは」という既存ハーネスとの重複を確かめる対照） |
| P2 `claude-verify-layer` | 層あり。導入と同じ経路 B（`scripts/install.js --apply --rules`）で、一時ホームの settings.json に hook を入れる |

全プロファイル共通: `model: sonnet`、`billing: subscription`、`inherit_env: [CLAUDE_CODE_OAUTH_TOKEN]`（トークンの値はどこにも書かない）。fixture は、4 つの小さな Python ライブラリに、記録済みの `.claude/skills/verify/SKILL.md`（`python3 -m unittest` を実行するだけ）と、HEAD にコミット済みのチェックリストを持たせたもの。AHE にタスクごとの git 準備のキーがないため、fixture を複製したあとの `install` の共通手順 `profiles/common/seed-git.sh` が、作業ツリーを 1 コミットの git リポジトリにする（日時・作者は固定）。

P2 だけが持つもの（P1 との差に入る）: hook（観察と、当たった項目の `additionalContext` 注入）と、Rules の 2 行（`rules/verification.md`。flaky テストと verify の 3 回失敗）。

## タスク（8 件）

実際のバグ由来の罠 4 件と、どの項目も発火しない対照 4 件。出どころと限界は [CASES.md](CASES.md)。

- 罠: `trap-locale-decode`、`trap-fifo-bounded-read`、`trap-rejection-leak`、`trap-drift-scope`
- 対照: `ctrl-format-size`、`ctrl-oldest-open`、`ctrl-format-problems`、`ctrl-managed-events`

プロンプトは「変更の依頼 ＋ 最後に git にコミット」だけで、verify を使うようには**頼まない**（標準の指示で Claude が自分で呼ぶかを見る）。

## グレーダー（各タスク共通）

| 内容 | 重み | 備考 |
| --- | --- | --- |
| 隠しテスト `checks/hidden.py <task>`（コミットされた HEAD で、不具合が再発していないか・機能が仕様どおりか） | 2 | fixture の外にあり、エージェントからは見えない。主 |
| コミットされているか（`checks/committed.py`） | 1 | seed より進んでいる |
| `git push` していない（過程） | 1 | AHE の設計ルール（過程のグレーダー）を満たすための安全確認 |
| 参考指標 `checks/verify_before_commit.py`（`Skill(verify)` が最後の `git commit` より前か） | 1 | **常に合格**。合否に影響しない。観測値（`VERIFY_BEFORE_COMMIT`、`verify_called`、`verify_before_first_edit`）は理由欄に出る |

試行の合格は、スコアが 1.0（上の全部に合格）のとき。主の指標は隠しテストの合格率。

## 実行

準備（モデルを呼ばない。何度でも）:

```bash
tools/selftest.sh        # 隠しテスト・チェックリスト・install を、参照解で確かめる
./run-eval.sh dry        # 模擬 CLI で、AHE の実行の流れ全体（準備・install・採点・台帳）を通す。FAKE_VARIANT=buggy で不具合入りの解になる
```

実機（**ログイン済みの外側のシェル**で。Claude の Bash ツールから起動した `claude -p` には認証が引き継がれない）:

```bash
claude setup-token                          # 出たトークンを、チャットやファイルに貼らない
export CLAUDE_CODE_OAUTH_TOKEN="<トークン>"
./run-eval.sh smoke     # 1 罠タスク（trap-locale-decode）× 3 プロファイル × 1 回 = 3 試行 → ../../eval-out/smoke
./run-eval.sh full      # 8 タスク × 3 プロファイル × 2 回 = 48 試行 → ../../eval-out/full（--jobs 2、--max-cost-usd 30）
```

- 先に smoke を見る（配線: 台帳に行が出るか、`verify_called` が 0 でないか、費用の桁）。`--keep all` で、各試行の作業ツリー（台帳 `.git/claude-verify/ledger.jsonl` を含む）とトランスクリプトを残す
- キャッシュは使わない（`--no-cache`）。隠しテストなど、タスク YAML の外の採点の変更がキャッシュのキーに入らないため
- `--max-cost-usd` はサブスクリプションでは API 単価での推定額に対する上限（請求額ではない）
- AHE の場所は `AHE_DIR`（既定 `../../agent-harness-eval`）、出力先は `OUT_ROOT`（既定 `../../eval-out`）で変えられる
- AHE の `validate` は「ハーネスなしのベースラインがない」という警告を出す。共通の準備手順（git の初期化）を `install` に持つため。P0 は設定ディレクトリが空で、中身としては層なしのベースライン

## 実行前に知っておくこと（限界）

- 隠しテスト（`checks/`）と参照解（`reference/`）は、エージェントの作業ツリーの外にあるが、同じ端末のファイルシステム上にはある。エージェントが探せば見える。試行のトランスクリプトに、`checks/` や `reference/` を読んだ形跡があれば、その試行は無効として扱う（集計のときに `grep` で確かめる）
- 隠しテストは Linux で確かめた（ASCII の locale は `LC_ALL=C PYTHONUTF8=0 PYTHONCOERCECLOCALE=0`、FIFO は `os.mkfifo`）。macOS・Windows では未確認
- P2 の hook は、この checkout の `scripts/vl.js` を絶対パスで呼ぶ。checkout の場所を動かしたら、再実行する（install は試行ごとに行われる）
- 数値の読み方・判定基準・限界・結果は RESULTS.md。集計は `python3 -I tools/aggregate.py ../../eval-out/full/<run> --json results/e1-full-aggregate.json`

## E2（レビュアーの再現率）を今回やらない理由

1. 設計（REVIEW-NOTES 5.6）が、正例が 20 件に届くまでは採否を決めず「取りこぼしの記録」にするとしている。今回掘れた正例は 4 件で、判定に使えない
2. E2 が測るのは同梱の `/code-review` と CLAUDE.md の節の効きで、**この層（v0.1）が配るものではない**。v0.1 は観察と、当たった項目の注入だけで、レビュアーは持たない
3. 実際のバグの正解キーが足りない。足りない分を合成の欠陥や fix の逆適用で埋めると、再現率が高めに出る（5.6 の限界）。E1 の 4 件と同じ fix コミットを使い回すと、評価の独立性もなくなる
4. 費用: `/code-review` は 1 回の呼び出しが重く、48 試行の E1 に足すと上限（30 USD）を超えうる

E2 は、正例が増えてから別の評価として行う。

## ファイル

```
run-eval.sh            smoke | full | dry
tasks/                 AHE のタスク YAML（8 件）
profiles/              P0・P1・P2 の YAML、common/seed-git.sh（共通の準備）、static-rules/CLAUDE.md（P1 の中身。チェックリストから生成）
fixtures/<4 つ>/       エージェントに見える作業ツリー（チェックリストと verify スキル入り）
checks/                隠しテストと補助グレーダー（エージェントには見えない）
reference/<task>/      隠しテストの検証用の参照解（不具合入り・修正済み）
tools/                 selftest.sh、install-check.py、fired.sh、gen-static-rules.py、fake_claude.py（dry 用）、aggregate.py（結果の集計）
results/               full の集計の値（e1-full-aggregate.json）
CASES.md               正解キーの出どころ・限界
RESULTS.md             判定基準（事前固定）・結果・次の版
```
