# 実機スモークの記録（2026-11-18）

> 追記（2026-11-20）: 下の結論は 11/18 の最初の実行の時点のものです。修正後の実機再実行（本文末尾の「追記: 修正後（f381cc6）の実機スモーク再実行」）で、Skill hook と commit 行は実機で確認できました（確認済み・未確認の現状は本文末尾の「実機での確認状況」）。README の「実機スモークの現状」も同じ内容です。

最初の実行の結論: **モデルを呼ぶスモークは、この環境では実行できませんでした**（`claude` が未ログイン）。台帳に行が出るかの実機確認は**できていません**。モデルを呼ばずに確かめられた範囲（プラグインの読み込みと hook の認識）だけを下に記録します。実機で未確認の項目は「未確認」と明記し、ログイン済みの端末で行う手順を最後に付けます。

## 環境

- Claude Code 2.1.325（`claude --version`）、Linux 6.12、Node 24.22.1、git 2.47.3
- 対象: このリポジトリの feat/v0.1（コミット 9748243 の時点）
- 計画: 使い捨てリポジトリに `.claude/skills/verify/SKILL.md`（`node check.js` を実行するだけの記録）を置き、`--plugin-dir` でプラグインを読み込み、haiku に「`a.js` の挨拶を変えてコミットして」と 1 回だけ頼む。台帳 `.git/claude-verify/ledger.jsonl` に run / commit の行が出るかを見る。

## 試したことと結果

### 1. モデルを呼ぶ実行 — 失敗（未ログイン）

```
cd <使い捨てリポジトリ>
ECC_GATEGUARD=off claude -p "In a.js change the greeting from hello to hi, then commit the change with the message 'change greeting'." \
  --model haiku --plugin-dir <このリポジトリ> \
  --allowedTools "Bash(git *)" "Bash(node *)" "Skill" "Edit" "Read" \
  --permission-mode acceptEdits --max-budget-usd 0.5 --no-session-persistence \
  --output-format stream-json --verbose --include-hook-events
```

- 結果: 1 ターンで終了（終了コード 1、費用 0 USD）。応答は `Not logged in · Please run /login`。使い捨てリポジトリにコミットは増えず、`.git/claude-verify/` もできていません。
- 原因の切り分け: `claude auth status` が `loggedIn: false`、`authMethod: none`。最小の呼び出し（「ok と答えるだけ」）でも同じ応答でした。`--setting-sources` を付けても付けなくても同じです。
- `claude -p` の呼び出しは合計 3 回です（モデルの応答は 1 度も得られていません）。(a) `--setting-sources project,local` で利用者の既存 hook を除いた条件、(b) 利用者設定も読み込んだ条件（上のコマンド）、(c) ログイン状態の確認のための最小の呼び出し（「ok と答えるだけ」）。いずれも `Not logged in` で 1 秒前後で終了し、費用は 0 USD でした。保存してある stream-json は (b) のものだけです。
- 対応: ログインや認証情報の探索は、利用者の認証に関わるため、この作業では行いませんでした。
- 2 回目の実行では、利用者の既存環境の hook（SessionStart・UserPromptSubmit に数件）が同じセッションで走っていることが、`--include-hook-events` の出力で確認できました。この層の hook はそれらと並列に載る設計です（PostToolUse と UserPromptExpansion だけ）。ただし、モデルが動かなかったため、PostToolUse が実際に発火したかは見られていません。

**このため、次の項目は実機で未確認です**（REVIEW-NOTES 第 6 節の未解決リスクと、DESIGN の「未検証・要確認」に対応）:

- 記録された `verify` を、標準の指示どおり Claude がコミット前に実際に呼ぶか
- `if: "Skill(verify)"` と `Skill(code-review)`（`/review` の別名）、入れ子の verify（`apps/web:verify`）が実際に当たるか
- `UserPromptExpansion` が、利用者が打った `/verify` で発火するか（版が changelog に出てこない。リスク 6）
- `additionalContext` でチェックリストの項目が Claude に届くか
- `if: "Bash(git commit *)"` が Claude の実際のコミットのどれだけを拾うか
- `PowerShell(git commit *)` の配線（この環境は Linux）

### 2. モデルを呼ばずに確かめられたこと — 成功

実機の 2.1.325 で、次を確認しました。

- **プラグインの読み込み**: `--plugin-dir` で読み込むと、`init` イベントの `plugins` に `verify-layer`（`source: verify-layer@inline`、`version: 0.1.0`）が出る。使い捨てリポジトリのプロジェクトスキル `verify` も `skills` に出る。
- **hook の認識**: `claude --plugin-dir . plugin details verify-layer` が、`Hooks (2)  PostToolUse, UserPromptExpansion`（`harness-only — no model context cost`）、`Skills (0)`、`Always-on: ~0 tok` と報告する。常時かかるトークン費用がない、という設計の主張と一致する。
- **マニフェストの検証**: `claude plugin validate .` は `success: true`、`manifest.errors: []`、`warnings: []`、`gatingHooks: []`。出る指摘は公開ディレクトリ向け（LICENSE がない、アイコンがない、README にインストール行がない）だけで、LICENSE を付けない方針なので意図どおり。
- **hook の入出力形式**: この層の hook は、自作の疑似入力（hooks.md の例と同じ形）で `doctor` と `node --test` が確かめている（終了コード 0、stdout は空か `hookSpecificOutput` だけの JSON、`decision` なし）。実機の Claude Code から実際の入力が渡されたときの確認は、上の「未確認」に含まれる。

## ログイン済みの端末で確かめる手順（最小・モデル費用は 1 回分）

1. 使い捨てのリポジトリを作る（`git init`、`.claude/skills/verify/SKILL.md` に「`node check.js` を実行して `OK:` が出れば PASS」、`a.js`、`check.js` を置いて 1 コミット）。
2. 上の `claude -p ...` を、**ログイン済みの端末で**実行する（`ECC_GATEGUARD=off` は、ECC の gateguard が入っている環境だけ。入っていなければ不要）。`--output-format stream-json --verbose --include-hook-events` を付けると、各 hook の発火が記録に残る。
3. 見るもの:
   - `node <このリポジトリ>/scripts/vl.js report`（run と commit の行が増えたか、結果は verified か）
   - `.git/claude-verify/ledger.jsonl`（`kind: run` の `via` が `model`、`kind: commit` の `session_verify` が `true` か）
   - stream-json の中に、この層の hook（PostToolUse、`vl.js hook run verify` / `hook commit`）の `hook_started` / `hook_response` があり、`exit_code` が 0 か
4. Claude が `/verify` を呼ばずにコミットしたなら、`result: none` の commit 行ができるはずです。それは「標準の指示が守られなかった」という観察で、この層の動作としては正しい結果です。
5. 利用者が `/verify` を打つ経路（UserPromptExpansion）は、対話セッションで `/verify` を打ってから `report` を見て、`via: user` の行ができるかを確かめる。導入先の 2.1.321 では、ここが最初の確認点になる。
6. 結果を、この文書の末尾に追記する（過去の記録は書き換えない）。

---

# 追記: ログイン済みの端末での実機スモーク（2026-11-18 16:22 JST）

上の記録（未ログインで失敗）のあとに、利用者が**外側のシェル（ログイン済み）**で、上の手順どおりに 1 回実行しました。生ログは `smoke-2026-11-18-haiku.jsonl`（このリポジトリの外）です。上の記録は書き換えず、この節で結果を足します。

## 条件

- Claude Code 2.1.325、モデルは haiku、`--plugin-dir <このリポジトリ>`、`--include-hook-events`
- 対象: `/tmp/vl-smoke`（`verify` スキル入りの使い捨てリポジトリ）
- 外側のシェルで実行した理由: Claude の Bash ツールから起動した入れ子の `claude -p` には、認証が引き継がれない（上の「未ログイン」はこれが原因）

## 結果

- 良い点
  - Claude は標準の指示どおり `Skill(verify)` を呼んでから、コミットした
  - `if: "Bash(git commit *)"` の PostToolUse hook が発火し、台帳に commit 行が書かれた（hook は 14 ms）
  - `report` の `git log` との突き合わせは 100%
- **不具合**: `Skill(verify)` の PostToolUse で、この層の hook が起動しなかった
  - `PostToolUse:Skill` の `hook_started` は 2 件だけで、どちらも ECC の hook だった。台帳に run 行がない
  - そのため commit 行は `result: none`、`session_verify: false` になった
  - 同じ入力を手で `vl.js hook run verify` に渡すと、run 行は正しく書かれた。つまり原因はスクリプトではなく、**`if: "Skill(verify)"` が 2.1.325 の実機で当たっていないこと**

## 対処

- Skill 側は `if` に頼らない。`matcher: "Skill"` の hook を 1 本（`vl.js hook skill`）にし、スクリプト側で `tool_input.skill` を見て判定する
  - `verify` と入れ子の名前（`apps/web:verify`）は verify、`code-review` と別名 `review` は code-review として記録する
  - それ以外のスキルでは何も出力せず、台帳にも書かずに、すぐ終了する
- インストーラの settings マージ版も、同じ 1 本になる（`hooks/hooks.json` から作るため）。古い `hook run verify|code-review` の登録は、再度 `--apply` すると置き換わる
- `if: "Bash(git commit *)"` は実機で当たったので残す。スクリプト側の HEAD 確認も変えていない
- テストを追加した（Skill hook が verify・入れ子の verify・`review`・`code-review` を記録し、ほかのスキルは無視すること。`hooks.json` の Skill hook に `if` が付かないこと）。実機ログと同じ形の入力（`tool_input.skill: "verify"`）を `hook skill` に渡して、run 行が書かれることも確かめた

## 実機での確認状況

- 確認できた: Skill の記録以外の配線（`Bash(git commit *)` の `if`、commit 行の書き込み、`report` の突き合わせ）と、標準の指示が守られたこと
- 修正後の実機での再確認は**まだ**。ログイン済みの端末で、上の手順を 1 回やり直し、run 行（`via: model`）ができて、commit 行が `verified` になるかを見る
- 引き続き未確認: `UserPromptExpansion`（利用者が打った `/verify`）、`PowerShell` の `if`

---

# 追記: 修正後（f381cc6）の実機スモーク再実行（2026-11-18 16:35 JST）

上の記録は書き換えず、この節で足します。利用者が外側のシェル（ログイン済み）で 2 回実行しました。生ログは `vl-smoke2.jsonl` と `vl-smoke3.jsonl`（このリポジトリの外）、台帳は `/tmp/vl-smoke/.git/claude-verify/ledger.jsonl` です。条件は前回と同じ（Claude Code 2.1.325、haiku、`--plugin-dir`、`--include-hook-events`、対象 `/tmp/vl-smoke`）。

## 1 回目: 指示なし（vl-smoke2）

- Claude は `Skill` を呼ばず、`node check.js` を Bash で直接実行してからコミットした（8 ターン、0.010 USD）。
- 台帳の commit 行は `result: none`、`session_verify: false`。
- 判定: Skill を経由していないので、この層からは verify と見なせない。前回は `Skill(verify)` を呼んだが、今回は呼ばなかった。**「標準の指示どおり verify を呼ぶか」は 1 回ごとにぶれる**（n=2 での観察）。同じ検証を Bash で済ませたかどうかは、この層の記録からは区別できない。

## 2 回目: 「verify スキルを使ってからコミット」と明示（vl-smoke3）

- `Skill(verify)` の run 行が `via: model` で書かれた（hook は 24 ms）。**修正した if なしの Skill hook は、実機で当たった**。
- ただし Claude は Skill を Edit の**前**に読み込み、実際の check（`node check.js`）は Edit の**後**に Bash で実行した。台帳の run 行のツリーハッシュは Edit 前のもの。
- そのため commit 行は `result: stale`、`stale_files: 1`、`since_run_s: 10`、`session_verify: true`。実態は「編集後に check を走らせて通った」なのに、台帳は「verify のあとで変えた」と判定した。
- これは REVIEW-NOTES 5.1 の「verify の記録は**始めた時点**のツリーで、検証が走った時点ではない」による系統的な誤判定の実例（偽の stale）。逆向き（verify は呼んだが check を走らせていない）の誤判定は、この層では起きても区別できない。

## 影響と扱い

- 判定ロジックは v0.1 のまま変えない（この作業の範囲外）。改善案は eval/RESULTS.md の「次の版」に書く。
- 評価（eval/）では、合格率とは別に「台帳の結果（verified / stale / none）が実態と合う割合」を報告する。実態は、隠しテストの結果と、トランスクリプトから読む「編集後に check を走らせたか」で決める。
- 実機での確認状況: 確認できた — Skill hook の記録（修正後）、commit 行、`stale` の出方。未確認のまま — `UserPromptExpansion`（利用者が打った `/verify`）、`PowerShell` の `if`。

## v0.2 の開始と Stop の確認

この節は v0.2 用の手順です。構造テストは一時ディレクトリと偽のホスト CLI を使います。

```sh
node --test tests/verify-v02-install.test.js tests/verify-v02-stop.test.js tests/verify-v02-core.test.js
```

構造テストでは hook の登録と削除、他の hook の保持、依頼 ID と依頼文の到達、初回の Stop 応答、再入、次依頼での枠の更新、検証後の編集による証拠の失効を調べます。

### 実セッションで確認する項目

候補ホストごとに、使い捨ての Git リポジトリを用意します。公開入口を持つ小さなモジュール、既存の公開テスト、`.verify-layer.json` を置き、`verifyV2.mode` を `enforce` に設定します。対象ホストの v0.2 hook と `verify2` スキルを導入します。利用者の本番設定とデータを持ち込まない検証用プロファイルを使います。

1. 依頼を開始して、hook のコンテキストに依頼 ID が出ることを確かめます。台帳の依頼状態と開始時スナップショットに対応する ID があり、送った依頼文も記録されていることを確認します。
2. ドキュメントだけの更新で終了できることを確認します。次の依頼では実装を変更し、境界テストを提出せずに終了させます。初回 Stop がブロックし、型付きケース入力、指定 assertion、取り下げ手順、失敗理由がホストに届くことを確かめます。
3. 同じ依頼で終了を続行します。ホストが `stop_hook_active` を真にして再入する経路と、台帳の介入済み記録で再入を止める経路を確認します。別の Stop hook を併用する場合は登録順を入れ替え、どちらの順でも追加ターンが依頼あたり 1 回以内であることを確認します。
4. 次の依頼で新しい依頼 ID が発行され、ケース枠と介入枠が更新されることを見ます。境界比較を通してから編集せずに終了する試行と、比較後に編集して終了する試行を分け、最終スナップショットの一致時だけ `検証済み` が記録されることを確認します。
5. ホストの版、イベントの有無、理由の配送、追加ターン数、最終スナップショットの照合結果を控えます。必要な開始イベントや Stop を通した介入を確認できないホストの強制条件は `実施不可` と記録します。

実セッションの結果欄は Claude Code、Codex CLI ともに未確認です。
