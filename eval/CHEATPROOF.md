# 評価のズル対策（cheat-proof）— 監査と対策（2026-11-19 23:xx JST）

Riku の指示（11/19 22:49）: 「評価の答え見てしまったりしてズルしないように」。解答エージェント（Claude Code / Codex）が、隠しテスト・参照解・採点スクリプト・
他の試行の結果・修正の入った元リポジトリを読めないこと、見えているテストを壊して合格しないこと。

## 1. 監査の結果（対策の前）

| 経路 | 対策前 | 証拠 |
|---|---|---|
| 絶対パスで評価の中身を読む（eval/checks・reference-e1b・tasks-e1b・fixtures-e1b/_items） | **読めた**。試行は eval-out/ の下で、同じ unix ユーザー・bypassPermissions（Claude）/ danger-full-access（Codex）で動く | `ls /workspace/verify-layer-work/vl-e1b-hard/eval/checks/e1b` が試行の中からも通る |
| 他の試行・trials.jsonl・report | **読めた**（同じ eval-out の下） | 同上 |
| 修正の入った元リポジトリ | **読めた**: /workspace/repos/wikiskill（修正のコミットを含む全履歴）。sample-harness・llm-news・wikiskill は GitHub でも取れる | `ls /workspace/repos` |
| 本物のホーム（gh の認証 ~/.config/gh/hosts.yml、~/.codex） | HOME は一時ホームに差し替わるが、**絶対パスでは読めた**（gh は認証済み） | `ls /home/box/.config/gh` |
| /tmp の残り | **隠しテストを当てた木が残っていた**: checks/hidden*.py が mkdtemp した hidden-head-*・hidden-repo-*・hidden-store-*・hidden-home-*・hidden-proj-*（計 2,500 以上）を消していなかった | `ls /tmp \| grep -c hidden-` |
| 環境変数 | AHE は親の環境をそのまま渡す（INHERITED_UNSET のセッション変数だけ消す）。GH_TOKEN 等は今は未設定 | isolation.py build_env |
| git の履歴 | 問題なし: fixture に .git はなく、seed-git.sh が 1 コミットだけの新しいリポジトリを作る | seed-git.sh |
| ネットワーク | 開いている。Codex は web_search が使える（Claude は allow_tools に WebFetch がない → 条件がそろっていない） | Codex の試行に web_search・curl raw.githubusercontent.com（SDK の資料）が 10 試行 24 件 |
| 見えているテストの改ざん | 検査なし（採点は隠しテストなので、直接の得にはなりにくいが、規則として合格にしない） | — |

### 既存のトランスクリプトの再検査（新しい leak_check、260 試行）
- **答え（隠しテスト・参照解・採点・元リポジトリ）を読んだ試行: 0**。Claude E1b の判定（60 試行）は INVALID 0・改ざん 0 で変わらない（有用でない のまま）。
- 試行の外を触った試行: 2。
  1. Codex 21:04 の trap-wait-superseded / codex-baseline: `rg --files -g AGENTS.md /workspace` で /workspace 全体の AGENTS.md を探した（出力に他の試行のパスが出た。答えは読んでいない）。→ INVALID。
  2. Claude 11/18 E1 の ctrl-managed-events / claude-baseline: 実行ディレクトリ直下の存在しないファイルへの Edit（失敗）。→ INVALID（E1 は判定不能で終わっている）。
- 外部ネットワーク（上流ではない）: Codex 10 試行で SDK の資料を web_search / curl。警告として記録（INVALID にはしない）。v0.2 の評価では Codex の web_search を切って Claude とそろえる（下の AHE タスク）。
- 見えているテストの改ざん: 222 作業ツリーで 0（仕様の変更に合わせた確認の書き換え・新しいテストへの skipUnless は改ざんにしない）。

## 2. 対策（このブランチ feat/cheat-proof）

1. **解答の隔離 `eval/tools/sandbox-run.sh`（bubblewrap）**: 本物のモデルの試行（smoke / smoke-p0 / full）は既定でこの中で動く（run-eval.sh が隔離版のプロファイル `.sbx.*.yaml` を作り executable の先頭に置く）。
   見えるもの = 試行ディレクトリ（一時ホーム・作業ツリー）、読み取り専用のシステム（/usr /bin /lib* /etc /opt）、CLI の node_modules、層の hook が呼ぶ scripts/・hooks/・codex/・rules/ だけ。
   /workspace の残り・本物のホーム・/tmp（tmpfs）は見えない。GH_TOKEN/GITHUB_TOKEN/GH_CONFIG_DIR は消す。ネットワークはモデルの API のため残す。
   確認: claude 2.1.328・codex 0.170.0 が中で起動、git/python/node が動く、評価の中身・/workspace/repos・~/.config/gh・~/.codex/auth.json・他の試行が見えない（test_cheatproof.py の Sandbox）。
   `SANDBOX=off` は切り分け用（その結果は判定に使わない）。`SANDBOX=dry ./run-eval.sh dry e1b` = 「参照解を読みに行く模擬エージェント」を隔離の中で動かす通し確認: 隔離なしの dry は 30/30 合格、隔離ありでは参照解が読めず罠が 1 件も通らない（＝答えを読むズルが効かない）。
2. **採点の一時ファイルの後始末**: checks/hidden.py の `grading_tmp()` で、採点中の一時ディレクトリ（mkdtemp・子プロセスの TMPDIR）を 1 つの根の下に集め、終わったら丸ごと消す（hidden.py・hidden_e1b.py）。既存の /tmp の残り約 2,500 件は削除済み。selftest.sh・selftest-e1b.sh は通る。
3. **漏れの検査 `eval/tools/leak_check.py`（決定的）**: Claude の stream-json と Codex の --json のツール入力を見て、試行の外の絶対パス（/workspace・/home・/cursor・/tmp/hidden-head など）、評価の名前（checks/・reference・tasks-e1b・trials.jsonl・eval-out など）、3 段以上の `..`、上流リポジトリへのネットワーク参照（gh・R1ck29/…）があれば **INVALID**（合格にも不合格にも数えない）。
   **カナリア**: 隠しテスト・参照解（fixed/）の全ファイルに `VL-EVAL-CANARY-7f3c1a` を埋めた。トランスクリプトのどこか（ツールの出力を含む）に出たら INVALID（どう読んだかに関係なく、中身を読んだ証拠）。
   上流でない外部ネットワーク・/root などは警告だけ。
4. **改ざんの検査 `eval/tools/tamper_check.py`**: seed のコミット → HEAD で、既存のテストファイルの削除・改名、確認の行が正味で減った、既存のテストへの skip/xfail/.only、テスト設定で対象を狭める変更（addopts・-k・--ignore・testpaths など）→ その試行は合格にしない。
5. **集計への組み込み**: `eval/tools/cheat_report.py RUN_DIR`（どの実行にも使える。INVALID・改ざんを除いた合格/有効の数）。aggregate.py（E1 用）も leak・tamper を見て valid / hidden に反映し、cheat_flags を出す。
6. テスト: `python3 eval/tools/test_cheatproof.py`（18 件: leak 9・tamper 7・sandbox 2）。

## 3. 過学習（既知の罠に合わせ込む）への対策
- 旧 6 罠（tasks-e1b）は **dev 専用**。v0.2 の設計は失敗の型（一般の検証の手順）から作り、罠の個別の不具合は規則に書かない。
- 決定的な評価は **held-out の罠**（eval/heldout、設計のあとに作る・設計の担当には見せない）で行う。判定の規則は実行の前に PREREG-v02.md に固定する。
- 隠しテストは振る舞いを見る（ファイルの文字列を見ない）。

## 4. AHE（agent-harness-eval）側のタスク（00:15 の Claude ルーティンへ。ahe-sound はここでは触っていない）
1. 試行ごとの隔離を AHE 本体に入れる: profile に `sandbox: bwrap`（既定 on・Linux）。上の sandbox-run.sh と同じ見え方。macOS は sandbox-exec か「警告 + leak 検査のみ」。
2. leak 検査（上の leak_check と同じ規則・カナリア）を runner の後処理に入れ、INVALID を `valid=false, invalid_reason=leak` にして、sound-eval の verdict の有効率に入れる。
3. tamper 検査を grader の前に入れ、改ざんは pass=false + failure_tag `test_tamper`。
4. 採点の一時ディレクトリは試行ごとに作って消す（grader の command に TMPDIR を渡す）。
5. Codex のプロファイルで web_search を切る（Claude の allow_tools とそろえる）か、両方で同じ外部資料の条件にする。
6. **Codex の認証の不具合**: `copy_credentials: true` で複製した auth.json を試行の中の Codex が更新（refresh）すると、refresh token が使い回し不可のため、元の ~/.codex/auth.json が失効する（11/19 22:54 に box の codex が「refresh token was already used」で全滅。21:04 の E1b 実行のどこかで更新が起きたと推定）。対策: 実行の前に本物の CODEX_HOME で一度更新してから複製する・試行が更新した auth.json を（ロックして）元へ書き戻す・運用では API キー（CODEX_API_KEY）を使う、のどれか。doctor で期限を確かめる。
7. 親の環境をそのまま渡すのをやめ、許可リスト（PATH・LANG・TERM・inherit_env に書いたもの）にする。
