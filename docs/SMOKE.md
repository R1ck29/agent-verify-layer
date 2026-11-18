# 実機スモークの記録（2026-11-18）

結論: **モデルを呼ぶスモークは、この環境では実行できませんでした**（`claude` が未ログイン）。台帳に行が出るかの実機確認は**できていません**。モデルを呼ばずに確かめられた範囲（プラグインの読み込みと hook の認識）だけを下に記録します。実機で未確認の項目は「未確認」と明記し、ログイン済みの端末で行う手順を最後に付けます。

## 環境

- Claude Code 2.1.325（`claude --version`）、Linux 6.12、Node 24.22.1、git 2.47.3
- 対象: このリポジトリの feat/v0.1（コミット 25aece9 の時点）
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
- 試行は 2 回です。1 回目は `--setting-sources project,local` で利用者の既存 hook を除いた条件、2 回目は利用者設定も読み込んだ条件（上のコマンド）。どちらも未ログインで 1 秒前後で終了し、費用は 0 USD でした。ほかに、ログイン状態の確認のための最小の呼び出しを 1 回行い、同じ応答でした。
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
