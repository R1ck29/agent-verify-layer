# DESIGN.md レビューノート（ハーネス検証レイヤー）

2026-11-18 · レビュアー兼設計者: Claude Code（Opus 5.5）

入力: DESIGN.md 全文、sources/article.md 全文、sources/ の公式ドキュメント（2.1.327 時点の写し）と changelog、この環境の Claude Code 2.1.325 のバイナリ（`strings`）、agent-harness-eval（main、pyproject 上は 0.8.0）、既存ハーネス（~/.claude、プラグイン、$E1B_REPOS_DIR/ の 6 リポジトリ。読むだけ）。モデルを呼ぶ実験はしていない。

凡例: 【確】文書・コード・バイナリで確かめた。【推】推論。行番号は sources/ のファイルの行。

## 0. 結論の要約

設計の骨格（verify の実行は標準の指示に任せる、観察モードから入る関門、HEAD から読むチェックリスト、レビュアーは 1 体、正解キーでの採点）は記事と合っており、残してよい。ただし、そのまま実装すると次の 6 点で動かないか、誤った数字を出す。

1. **Windows で関門が発火しない**: Git Bash のない Windows では Bash ツールが登録されず、`matcher: "Bash"` の hook は一度も動かない（hooks.md:1874-1878）。Git Bash があっても PowerShell ツールが有効なら主シェルは PowerShell になる（その推論経路では 2.1.143 から既定で有効。changelog:8940）。matcher は `Bash|PowerShell` にし、`if` も 2 本立てる必要がある。
2. **verify の「実行の記録」は開始時点の記録になる**: 同梱の `/verify` は `context: fork` を持たず、会話の中で動く【確: バイナリの登録に fork 指定なし】。そのため PostToolUse(Skill) は手順の読み込み直後、つまり確認作業の前に発火する。verify 中の修正や、初回の `/verify` が書く `.claude/skills/verify/SKILL.md` で作業ツリーのハッシュが変わり、正しく確認したコミットでも stale になる。
3. **PreToolUse の関門は ECC の gateguard と並列に走る**: 同じイベントの hook は並列に動く（hooks.md:409）。gateguard が deny したコミットにも台帳の行ができ、存在しないコミットの行（幻の行）が残る。観察モードには PreToolUse は要らない。成功したコミットにだけ発火する PostToolUse で記録すれば、この問題はなくなる。
4. **OTEL テレメトリの前提が崩れている**: agent-harness-eval は 2026-11-03 に、利用者から信号を戻す経路を「作らない」と決めた（docs/design.html:258）。Claude Code も hook の子プロセスから `OTEL_*` を取り除く（hooks.md:774）。台帳はローカルに置き、件数は利用者が自分で `report` を実行して見る形にする。
5. **標準の指示が消える条件が足りない**: 管理設定の `strictPluginOnlyCustomization`（skills.md:198）、`--bare`・`--safe-mode`、`skillOverrides` の `user-invocable-only`（skills.md:340）でも、プロジェクトの verify が読み込まれないか、Claude が呼べなくなる。インストーラが確かめる項目に加える。
6. **SQL 向けの個人用 `verify` は初版から外す**: 名前を `verify` にする理由は標準のコミット前指示だけで、効くのは git にコミットする場合に限られる。git 管理のクエリなら、そのリポジトリのプロジェクトスキルにすれば足りる。個人用の場所に置くと、すべてのリポジトリの記録を上書きする。

**初版は「観察だけの台帳」と「HEAD から読むチェックリスト照合」の 2 つに絞り、新しい独立リポジトリ `claude-verify-layer` に置く**（第 5 節）。enforce、掘り起こし、刈り込み、SQL 向け verify は、観察データと評価の結果を見てから作る。

## 1. 記事全文と設計の対応

前回は節ごとの要約しか使っていなかったため、全文（sources/article.md）と 1 段落ずつ突き合わせた。

### 1.1 設計が誤読している点

| 記事（行） | 記事の内容 | 設計の扱い | 判断 |
| --- | --- | --- | --- |
| 116, 120 | 関門は「**セッションに /code-review か /verify が含まれていたか**」で止める。説明を書けば通り、2 回止めたら次は通す | verify だけを数え、作業ツリーのハッシュに結びつける。セッション単位で結びつける案は「確認後の編集を見逃す」として不採用 | ハッシュ方式は記事より厳しく、誤判定も増える（第 0 節の 2）。記事に合わせて `/code-review` も記録し、**セッション単位の判定とツリー単位の判定を両方残す**。観察期間にどちらが役立つ信号かを比べる |
| 108 | 「古いコミットのレビューは無意味」は、PR のレビュー中に push が続く状況の話 | 作業ツリーのハッシュの根拠にしている | 根拠としては弱い。ハッシュは「確認後に変えたか」を見る別の指標として扱い、意味づけを分けて書く |
| 110 | 安いチェックから先に。**テスト・ビルド・lint を、共有のレビューや CI に出す前に**走らせる。手段として「Claude が終わったときにテストを走らせる hook」か `/goal` を挙げている | 「verify の記録手順に任せる」とし、Stop hook は「常時の費用」として不採用 | 誤読。command 型の Stop hook はモデルを呼ばないので、トークン費用はかからない（かかるのは実行時間）。直接コミットが中心なら、記事の「PR の前」は「コミットの前」に当たる。不採用の理由は「時間がかかり、質問だけのターンでも発火する」に直す。初版では作らないが、`git status` が汚れていなければすぐ抜ける作りなら費用はほぼない、と書き残す |
| 102 | レビューと検証の各ラウンドは、**前のラウンドの結果と過去の失敗を文脈として渡して**積み上げる | 「1 体」だけを取り、「複数ラウンド」は落としている | 落としている。初版では、関門の台帳と直近の verify の結果を、2 回目のレビューに渡す手順を文書に書く程度でよい |
| 94-96 | チェックリストの各項目は「diff から読める発火条件」「確認内容」「元になった事故や PR」を持つ。**Claude が diff を読んで**当てはまる 3〜10 件だけを確認する | 発火判定を決定的な照合（glob と正規表現）に置き換えた | 置き換えは妥当（決定的で、トークンを使わない）。ただし記事の例「--resume が古い transcript を読む」のような、意味で決まる発火条件は正規表現では書きにくい。項目に `paths`（必須）と `pattern`（任意）を持たせ、取りこぼしは評価で測る |

### 1.2 設計が落としている点

| 記事（行） | 記事の要点 | 扱い |
| --- | --- | --- |
| 90 | **コードの持ち主がそのコードのチェックを書き、持ち主が指摘したい点を指摘できるまで磨く**。チェックが人を呼ぶときは理由を言う | チェックリストの項目に `owner` と `why` を必須で持たせる。照合結果を Claude に渡すときも理由を添える |
| 78 | verify スキルは「関係するコードのできるだけ近くに、必要なだけ」置く | 設計はリポジトリ直下だけを扱う。`/verify` も monorepo では触ったパッケージの中に記録する（skills.md:67）。関門の判定と導入手順に、入れ子の verify も含める |
| 80 | verify は速く確実にし、Claude に繰り返させて負荷をかけて試す | 導入手順に「記録後に 2 回続けて実行し、結果が同じか見る」を入れる |
| 86 | 3 回目の失敗で人を呼ぶ（設計にある「2 回目は Opus」は記事にない） | 既存の「2 回目で Opus」は ~/.claude の Rules にも CLAUDE.md にも見当たらない【確: grep】。導入先の Rules にあるなら残す。なければ「3 回で人を呼ぶ」だけにする |
| 128 | 再現率を「生の指摘」「検証後」「最終」の段階ごとに測る | 同梱の `/code-review` の中は見えないので、段階ごとには測れない。評価の限界として明記する（第 5.6 節） |
| 130-132 | 重要度（Important / Nit / Pre-existing）。pre-existing は作者の責任にしない | 対照の誤検知を数えるとき、pre-existing と nit は別に数える |
| 124 | revert の数、マージ前に却下された数、大きさをそろえた問題のない変更、を追う | 設計の例題作りにあり、合っている |
| 134 | 再現率は、評価への過学習が始まる手前まで上げる | 設計の「dev で改善しても holdout で出なくなったら止める」と合っている |
| 138 | 規則化の条件は「2 件以上の PR に出て、diff から識別できる」こと。3 体のエージェントが反証を試み、人が承認する | 設計と合っている。ただし初版では作らない（月 1 回、手で回す） |
| 142 | flaky なテストは skip・sleep・通るまでの再試行で済ませない。原因が分からなければ削除し、理由を書く | Rules の 1 行と、チェックリストの 1 項目で足りる |
| 144, 148 | Rules も検証手順も .md も放っておけば増える一方なので、定期的に刈る | 刈り込みに要る「発火回数」は、ローカルの台帳だけで数えられる |
| 45 | 機能一覧（feature map）を E2E の手引きと採点基準にする | 初版の対象外。verify を記録するときのヒントとして README に書く程度 |
| 27 | 遅いテストはコミット前に寄せる | 関門の位置づけと合っている |

### 1.3 合っている点

- 記事 106 行「変更が自分を判定するチェックを書き換えられない」→ 設計は HEAD から読む。直接コミットでは、1 つ前のコミットでチェックリストを書き換えれば次のコミットはそれで判定される（2 段階で抜けられる）。設計の「チェックを変える変更を人に出す」でこれを補う。初版では、照合結果にこの警告を必ず添える
- 記事 112-118 行の off / observe / enforce と、「none」も記録して問い合わせられること
- 記事 100 行の「レビュアーを重ねない」

## 2. 公式ドキュメントでの事実確認

対象は DESIGN.md の「公式ドキュメントで確認したこと」の各行と、本文で前提にしている事実。sources/ の写しは 2.1.327（2026-11-17）時点のもので、この環境の 2.1.325 より新しく、導入先の 2.1.321 よりさらに新しい。版の差は changelog で確かめた。

| # | 設計の記述 | 判定 | 根拠 | 補足・設計への影響 |
| --- | --- | --- | --- | --- |
| 1 | v2.1.286 以降、`verify` か `simplify` という名前のスキルがあれば、コミット直前に実行するよう指示が入る。docs・tests だけの変更は除く | **合っている** | skills.md:74 に「verify or simplify」「v2.1.286 or later」。changelog:3700（2.1.286）には verify だけが書かれている | バイナリ 2.1.325 の文面は ``Always run `/verify` right before the `commit` command (never for docs or tests).`` で、**Bash ツールの説明文に入る**【確】。この文面の生成はフラグ `tengu_polished_tulip` の下にあり、既定は on【確】。その推論経路ではフラグを取りに行かない（skills.md:259）ので、既定値が使われる【推】。版が変われば消えうる |
| 1a | （設計にない）`/code-review` も同じ指示に入りうる | **文書にない** | バイナリに `codeReview: ... && includeCodeReviewSuggestion===!0` があり、条件を満たせば `` `/code-review medium` `` が並ぶ【確】。settings.md・changelog には出てこない | 文書にない設定なので依存しない。観察期間中に試す候補として未解決リスクに挙げる |
| 2 | 対象はエンタープライズ・個人・プロジェクトなどのスキル。同梱版・プラグイン・claude.ai のスキルは対象外 | **合っている** | skills.md:76。追加ディレクトリと `.claude/commands/` の同名ファイルも対象 | プラグインで `verify` を配っても効かない、という設計の結論は正しい |
| 3 | `disable-model-invocation: true` や `includeGitInstructions` の無効化で指示が消える | **合っている（条件が足りない）** | skills.md:77-78。`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` も同じ（バイナリの `e_t()`）【確】 | このほかに、`skillOverrides` の `user-invocable-only`（skills.md:340）、プロジェクトのスキルを読まない `strictPluginOnlyCustomization`・bare・`--safe-mode`（skills.md:198）でも指示は入らない。インストーラの検出項目に加える |
| 4 | `/verify` はユーザーが呼んだときだけ動く（v2.1.215 以降） | **合っている（フラグ次第）** | changelog:7114（2.1.215）。バイナリでは `disableModelInvocation: () => !dWo()` で、フラグが読めないときの既定は「モデルからは呼べない」【確】 | 同梱版はモデルから呼べないが、記録されたプロジェクトの verify はモデルから呼べる。設計の前提どおり |
| 5 | 記録がなければ `.claude/skills/verify/SKILL.md` に書き、リポジトリ直下では同梱の `/verify` を置き換える | **合っている（monorepo の扱いが抜けている）** | skills.md:67。monorepo では触ったパッケージの中に書く。記録の書き直しは、手順が誤っていたときだけ（skills.md:69、changelog:7527） | 関門は、入れ子の `verify` の実行も数える（`Skill(verify)` は入れ子の名前にも当たる: skills.md:900） |
| 6 | `/run-skill-generator` は `.claude/skills/run-<name>/` に記録し、`/run` と `/verify` がそれに従う | **合っている** | skills.md:65、commands.md:136 | 名前が `verify` ではないので、標準の指示の対象にはならない（設計どおり） |
| 7 | 同名スキルの優先順位は、エンタープライズ > 個人 > プロジェクト。プラグインは名前空間つきで衝突しない | **合っている** | skills.md:213-214, 220 | 個人用の場所に `verify` を置くと、全リポジトリの記録を上書きする。第 4 節で SQL 向けをやめる根拠 |
| 8 | `/code-review` はどのプランでも動き、セッション内で、背景の subagent として実行される | **合っている** | code-review-local.md:11, 36 | 背景で動くので、指摘が届く前にコミットが進みうる。前景で動かすのは `-p`、`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`、または 2 回目の実行（同:108-112）。評価では `-p` なので前景で動く |
| 9 | 会話履歴を持たない subagent で動く | **合っている** | code-review-local.md:71（forked subagent）。skills.md:805, 809（`context: fork` は会話履歴を見ない。会話の fork ではない） | 実機での確認は残す |
| 10 | CLAUDE.md に従い、REVIEW.md は読まない | **合っている** | code-review-local.md:65、156 | 設計どおり |
| 11 | `ultra` は その推論経路では使えず、ローカルのレビューに切り替わる | **合っている** | code-review-local.md:150 | 導入先に影響なし |
| 12 | 管理型 Code Review は REVIEW.md をベースのブランチから読む | **合っている** | code-review-customize.md:14, 43, 135。記事:106 | この環境では使えない（GitHub に届かない） |
| 13 | （本文）Claude が自分から `/code-review` を始めることはない | **文書の間で食い違う** | changelog:7114（2.1.215）は「自分からは実行しない」。code-review-local.md:116 は「平易な言葉で頼めば Claude が始められる」 | 自動で走ることを前提にしない。台帳には「実行されたか」だけを残す |
| 14 | `/goal` はセッション単位のプロンプト型 Stop hook。small fast model で評価し、ツールを呼ばない | **合っている** | goal.md:120, 174 | 評価モデルは `ANTHROPIC_DEFAULT_HAIKU_MODEL` で変えられる（goal.md:168）。その推論経路では要設定 |
| 15 | Stop hook は、間にツール呼び出しがないまま 8 回連続でブロックすると上書きされる | **合っている（結論の理由が弱い）** | hooks-guide.md:1010、hooks.md:2853、changelog:8954 | 上限は `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` で上げられ、ツールを呼ぶたびに数え直す（hooks-guide.md:1021）。「完了判定に使わない」理由は、この上限ではなく時間と、質問だけのターンでも発火すること（第 1.1 節） |
| 16 | hook の `if` は permission ルールの形で書け、`Bash(git commit *)` や `Skill(verify)` が使える。ツールのイベントでだけ効き、Bash の判定はベストエフォート | **合っている** | hooks.md:424（効くのは PreToolUse・PostToolUse・PostToolUseFailure・PermissionRequest・PermissionDenied。ほかのイベントでは、`if` のある hook は動かない）、429（1 つの hook に 1 規則）、437-445、skills.md:893。`if` は 2.1.85 で追加（changelog:10520） | `Bash(git commit *)` は `git -C dir commit` に当たらない（パターンは前方一致）【推: 表 437 の規則から】。`npm test && git commit` には当たる。**Windows では `PowerShell(git commit *)` が別に要る**（hooks.md:119, 1874-1878） |
| 17 | UserPromptExpansion は、利用者が打ったコマンドが展開されるときに発火し、コマンド名で絞れる | **合っている（版は確認できない）** | hooks.md:36, 310, 1603-1650。入力に `command_name`・`command_args`・`prompt` がある | changelog に追加した版が見つからない。この環境のバイナリには文字列がある【確】。導入先の 2.1.321 で動くかは実機で確かめる。**入力の `prompt` と `command_args` は台帳に書かない** |
| 18 | Windows の hook のシェル形式は Git Bash が要る。`"args": []` の exec 形式ならシェルを通さずに起動できる | **半分違う** | hooks.md:462-470。exec 形式は 2.1.139（changelog:9125） | Git Bash がなければ、シェル形式は PowerShell で動く（hooks.md:466）。「Git Bash が要る」のではなく「bash 用に書いた行が PowerShell で壊れる」。exec 形式では `command` が本物の実行ファイルでなければならない。`node` と、`args` に渡すスクリプトのパスの組み合わせなら全 OS で動く（hooks.md:470）。**Node が入っていない端末では動かない**（Claude Code 本体はネイティブのバイナリで、Node を前提にしない）。インストーラで検出する |
| 19 | すべてのイベントの入力に `session_id` と `cwd` が入る | **合っている** | hooks.md:748-760。subagent の中では `agent_id`・`agent_type` も入る（hooks.md:255） | subagent が作ったコミットも、同じ hook で記録できる |
| 20 | （本文）PostToolUse の `additionalContext` で、チェックリストの項目を Claude に渡せる | **合っている** | hooks.md:2320-2330。UserPromptExpansion でも渡せる（hooks.md:1630-1640） | 利用者が `/verify` を打ったときにも、UserPromptExpansion から同じ項目を渡す |
| 21 | （本文）Agent Harness Eval v0.5 の「内容を含まない信号」に件数を OTEL で足す | **違う** | agent-harness-eval の docs/design.html:258（2026-11-03 に「この経路は作らない」と決定）。harness_eval/ に OTEL 送信はない。hooks.md:774（hook の子プロセスから `OTEL_*` が取り除かれる） | テレメトリはやめる。台帳はローカルに置き、`report` で集計する |
| 22 | （本文）Agent Harness Eval v0.5 の train / dev / holdout、`promote`、符号検定、`--monthly-budget-usd` | **合っている（版の表記が古い）** | リポジトリは 0.8.0。`spec.py:62` の `SPLITS`、`metrics.py:84` の `sign_test`、`metrics.py:403` の `promote`、`spec.py:66` の `MIN_HOLDOUT_TASKS=20`、`cli.py:548` | dev の関門の正体は `gate --max-regressions`。同じ family を複数の分割に入れると警告が出る（`spec.py:461`） |
| 23 | （本文）一時インデックスで `git add -A` し、`git write-tree` でツリーのハッシュを求める | **合っている（速さに注意）** | git の標準の動き | 空の一時インデックスから始めると、全ファイルをハッシュし直して遅い。本物の index をコピーしてから `git add -A` すれば、stat のキャッシュが効く。worktree では `.git` がファイルなので、置き場所は `git rev-parse --git-path claude-verify` で求める |
| 24 | （本文）PostToolUse(Skill verify) で「verify が実行された」ことを記録できる | **一部違う** | PostToolUse は、ツールの処理が終わった直後に発火する（hooks.md:2270）。インラインのスキルでは、それは手順を読み込んだ時点にあたる。同梱の `/verify` に `context: fork` はない【確: バイナリ】 | 記録されるのは「verify を始めた時点のツリー」。第 0 節の 2 のとおり、誤って stale になる経路がある。第 5 節で、コミットに含まれるファイルだけを比べるよう変える |

### 2.1 版ごとの注意（導入先 2.1.321 と、この環境の 2.1.325）

- 初版が使う機能の最低版: `if` は 2.1.85、exec 形式は 2.1.139、verify の指示は 2.1.286、`onFailure` は 2.1.295（changelog:2842）、割り込み後に PostToolUse が走るのは 2.1.319（hooks.md:2290）。どれも導入先の 2.1.321 より前
- 2.1.326 で、`"decision": "block"` が効く場面が増えた（changelog:229）。観察モードの hook は `decision` を一切出さない
- 2.1.327 で、`/status` に「一度も当たらない hook の matcher」の一覧が出るようになった（changelog:22）。導入先の 2.1.321 にはないので、導入後の確認は自作の `doctor` で行う
- UserPromptExpansion を追加した版は changelog にない。手元での発火確認は導入直後の smoke test で行う

## 3. 既存ハーネスとの重複

調べた範囲: ~/.claude の CLAUDE.md・rules・skills・agents・settings.json の hooks、有効なプラグイン（ECC 2.2.3、autoresearch 2.3.0、superpowers 7.0.2、code-review@claude-plugins-official ほか）、$E1B_REPOS_DIR/ の 6 リポジトリ。読んだだけで、どれも変更していない。

| 設計の部品 | 重なる既存部品 | 重なり方 | 判断 |
| --- | --- | --- | --- |
| A. verify を標準の指示に任せる | CLAUDE.md の「4. Verification Before Done」。superpowers `verification-before-completion`（コミット前の未検証を危険信号に挙げる）。ECC `verification-loop` | 部分重複。どれも指示だけで、記録も強制もしない。プラグイン配布なので、標準の指示の対象外 | **残す**。名前が `verify` のスキルは個人用の場所にもプラグインにもない【確】ので、リポジトリの記録は上書きされない |
| B. コミットの関門と台帳 | ECC `pre-bash-dispatcher.js` の gateguard-fact-force（セッション最初の、読み取り専用でない Bash を 1 回 deny する。`commit --amend` なども初回は deny）と block-no-verify。ECC `skill-run-tracker.js`（PostToolUse(Skill) を `~/.claude/state/skill-runs.jsonl` に記録。ツリーのハッシュは持たない）。sample-harness `session_hooks.py`（観察して、次のセッションで知らせる形の前例） | **衝突**（gateguard）、部分重複（skill-run-tracker） | **変える**。観察は PostToolUse で行い、gateguard と同じ PreToolUse には載せない。enforce を作るときは、自分の deny だけを数える。ECC が入った環境では、skill-run-tracker の記録と台帳が二重になるが、目的（ツリーとの照合）が違うので統合はしない |
| C. diff で発火するチェックリスト | ECC `hookify-runtime.js`（PreToolUse・UserPromptSubmit・Stop で規則を評価する。規則ファイルはない）。`rules/code-review.md` 25-37 行（diff と関係なく、いつも読まれる固定のチェックリスト）。cc-review-tool-eval `harness/string_contracts.py`（LLM を使わない決定的な照合） | 部分重複。「HEAD から読む」「diff で発火する」「元の事故を持つ」の 3 つを兼ねるものはない | **残す**（初版の中心）。hookify は作業ツリーの規則を読むので、「変更が自分のチェックを変えられない」を満たさない |
| D. レビュアーは 1 体（`/code-review`） | `skills/review-changes`（CRG を使う）、`agents/graph-reviewer.md`、ECC の `*-reviewer` 25 体と `code-review` / `review-pr` / `orch-review` / `astra-review`、superpowers `requesting-code-review`、プラグイン `code-review@claude-plugins-official` | **衝突**。`rules/agents.md`、`rules/development-workflow.md`、`rules/code-review.md` が、複数のレビュアーを毎回呼ぶよう指示している | **方針は残す。範囲は変える**。導入先に配る物には `/code-review` だけを入れる。Riku の環境の Rules にある複数レビュアーの指示は、この部品の範囲外（別に整理する）。`code-review@claude-plugins-official` は `gh pr` 専用（`allowed-tools` が gh だけ）で、GitHub に届かないこの環境では動かない。同梱の `/code-review` と名前が紛らわしいので、導入先に配らないよう INSTALL に書く |
| E. SQL 向けの個人用 verify | agent-harness-eval の `examples/tasks/request-extract.yaml` と `request-ambiguous.yaml`（条件を間違えたクエリ、曖昧な依頼の確認） | 補完。評価の例題はすでにある | **やめる**（初版から外す）。第 4 節 |
| F. Rules の 2 行 | superpowers `systematic-debugging`（3 回修正に失敗したら止まる）。ECC の testing rules（flaky なタイムアウトを避ける） | 部分重複 | **変える**。flaky の 1 行は残す。「2 回目は Opus」は既存の Rules に見当たらないので、導入先にない限り落とす |
| G. Agent Harness Eval で採点 | cc-review-tool-eval（欠陥 12 件、英語 1 文の正解キー、`MATCH` の同義語グループによる決定的な採点、McNemar 検定。対照はない。`/code-review` との比較はない）。AHE の `command` / `llm` / `hook_used` / `skill_used` グレーダー、split、`promote` | 補完。正解キーと採点の仕組みは流用できる | **残す**。具体案は第 5.6 節 |
| H. 見逃しの掘り起こしと刈り込み | CLAUDE.md の Self-Improvement Loop（`tasks/lessons.md`）。ECC `continuous-learning-v2`。wikiskill（評価で点が上がったときだけ採用する仕組み） | 部分重複。どれも fix や revert のコミットを起点にしない | **後回し**。初版では、月 1 回、手で回す手順だけを文書にする |
| テレメトリ（OTEL） | AHE は「作らない」と決定済み | 衝突（方針） | **やめる** |

既存の作りで、そのまま流用できるもの:

- **設定のマージ**: sample-harness `scripts/install_pc.py`。自分の hook はコマンドの絶対パスだけで見分け（timeout まで照合すると二重登録が起きた経緯がある）、自分の分だけを外してから入れ直す。タイムスタンプ付きのバックアップを取り、`--check` と `--uninstall` を持つ。wikiskill `tools/integrate.py` の `hooks_blocked()` は、管理設定が hook を止めていないかを先に調べる
- **hook の出力**: ECC `suggest-compact.js` 251-257 行のコメント「止めない PreToolUse の stderr は debug ログにしか出ない」。ECC `bash-hook-dispatcher.js` 111-115 行の「入力をそのまま stdout に返すとスキーマ検証で落ちる」。言うことがなければ何も出さない
- **exec 形式の hook**: 前例は sample-harness の hook だけ。ECC・autoresearch・wikiskill はシェル形式で、Windows では Git Bash を前提にしている

## 4. コンポーネントごとの判断

| 部品 | 判断 | 理由 |
| --- | --- | --- |
| 1. verify は標準の指示に任せる | **残す（確認項目を足す）** | 事実確認 #1〜#7 は合っていた。インストーラの `doctor` が確かめる項目に、`skillOverrides`、`strictPluginOnlyCustomization`、`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`、個人用やエンタープライズの場所にある `verify` や `simplify`（全リポジトリを上書きする）を加える。monorepo の入れ子の verify も対象にする |
| 2. 実行の記録（PostToolUse(Skill)、UserPromptExpansion） | **変える** | 記録は「始めた時点のツリー」として残す。`/code-review` の実行も同じ方法で記録する（記事の関門の条件）。台帳に書くのは時刻、経路（model / user）、スキル名、ツリーのハッシュ、session_id だけにする。`prompt` と `command_args` は書かない |
| 3. コミットの関門 | **変える** | 初版は observe だけで、**PostToolUse（`Bash\|PowerShell`、`if` を 2 本）で、成功したコミットを SHA で記録する**。判定は、コミットされたファイルについて、直近の verify 時のツリーと `HEAD^{tree}` の差を見る。差がなければ verified、あれば stale（差のあるファイルの数を残す）、記録がなければ none。docs と tests だけなら skipped（glob は設定で変えられる）。同じセッションで verify か code-review を実行したか（記事の基準）も同じ行に残す。PreToolUse での deny（enforce）は、観察の結果を見てから第 2 段で作る |
| 4. diff で発火するチェックリスト | **残す（形式を変える）** | YAML は Node の標準機能では読めず、ZIP で入れる環境に依存パッケージを持ち込みたくないので、`.claude/verification/checklist.json` にする。項目は `id`、`paths`（glob、必須）、`pattern`（追加行に当てる正規表現、任意）、`check`、`why`、`incident`、`owner`。HEAD 側を読み、照合する差分は `git diff HEAD` と未追跡ファイルの名前。渡すのは verify の hook と UserPromptExpansion の `additionalContext`。当たりがなければ何も出さない。チェックリスト、CLAUDE.md、hooks、`.claude/skills/verify/` を触る変更には、必ず「チェックを変える変更」の警告を添える |
| 5. レビュアーは 1 体 | **残す** | 「何を重視するか」は CLAUDE.md の短い節で渡す。チェックリストはレビュアーには届かない（設計どおり）。`includeCodeReviewSuggestion` は文書にないので使わない |
| 6. SQL 向けの個人用 verify | **やめる** | 個人用は全リポジトリの記録を上書きし、データ抽出の利用者がほかのリポジトリで作業するときにも発火する。`verify` という名前が要るのは git のコミット前の指示のためだけ。git 管理のクエリなら、そのリポジトリのプロジェクトスキル `verify` で足りる。git 管理でないなら、`sql-check` のような別名で、説明文から呼ばれる形にすれば上書きの問題が起きない。どちらも、Trino で小さく試せる場所が決まってから作る |
| 7. Rules の 2 行 | **変える** | flaky の行は残す。「verify が 3 回続けて失敗したら止まって人に報告する。そのとき、どのチェックがなぜ落ちたかを書く」（記事:86, 90）。「2 回目は Opus」は落とす（導入先の Rules にあるなら、それに従う） |
| 8. チェック自体の採点 | **変える** | OTEL をやめ、AHE 0.8.0 の実在する機能で組む（第 5.6 節）。正解キーが 5 件しかないうちは、`promote` で採否を決めず、取りこぼしの記録として使う（設計どおり） |
| 9. 見逃しの掘り起こし・刈り込み | **後回し** | 初版の台帳とチェックリストが動いてからでないと、入力が足りない。台帳に「どの項目が発火したか」の id を残しておけば、あとで刈り込みの分母に使える |
| 10. テレメトリ | **やめる** | 事実確認 #21 |
| 11. 段階導入（自分 → エンジニア → …） | **残す** | フェーズ 0 で自分の環境の観察から始める、という順番は正しい |

## 5. 調整済み計画

### 5.1 初版（v0.1）の範囲

作るのは次の 4 つだけにする。どれもモデルを呼ばず、観察モードでは利用者の作業を一切止めない。

1. **台帳**（`vl.js hook ...`）: verify と code-review の実行、成功したコミットを、`git rev-parse --git-path claude-verify` の下の `ledger.jsonl` に追記する
2. **チェックリスト照合**（`vl.js hook ...` の一部）: HEAD 側の `.claude/verification/checklist.json` を、`git diff HEAD` と未追跡ファイルの名前に照合する。当たった項目を、verify の開始時に `additionalContext` で渡す。ファイルがなければ何もしない
3. **集計と診断**（`vl.js report` と `vl.js doctor`）: 台帳の内訳と、`git log` との突き合わせ（拾えなかったコミットの推定）。標準の指示が入る条件と、hook の配線を確かめる
4. **導入物**: プラグイン形式の `hooks/hooks.json`、プラグインが使えない環境向けの settings へのマージ、Rules の 2 行、`INSTALL_FOR_CLAUDE.md`

作らないもの: enforce（deny）、OTEL、SQL 向けの verify、掘り起こしと刈り込みの自動化、自作のレビュアー、Stop hook。

hook の配線（プラグイン形式。`if` は 1 つの hook に 1 規則なので、Bash と PowerShell で別の hook にする）:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Skill", "hooks": [
        { "type": "command", "if": "Skill(verify)",      "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/vl.js", "hook", "run", "verify"],      "timeout": 10, "onFailure": "continue" },
        { "type": "command", "if": "Skill(code-review)", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/vl.js", "hook", "run", "code-review"], "timeout": 10, "onFailure": "continue" }
      ]},
      { "matcher": "Bash|PowerShell", "hooks": [
        { "type": "command", "if": "Bash(git commit *)",       "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/vl.js", "hook", "commit"], "timeout": 10, "onFailure": "continue" },
        { "type": "command", "if": "PowerShell(git commit *)", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/vl.js", "hook", "commit"], "timeout": 10, "onFailure": "continue" }
      ]}
    ],
    "UserPromptExpansion": [
      { "matcher": "(^|:)(verify|code-review|review)$", "hooks": [
        { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/vl.js", "hook", "expand"], "timeout": 10, "onFailure": "continue" }
      ]}
    ]
  }
}
```

- UserPromptExpansion の matcher は、英数字・`_`・`-`・`|` だけなら完全一致になり、それ以外の文字を含むと先頭に固定されない正規表現になる（hooks.md:282-283）。入れ子の `apps/web:verify` にも当てるため、上のように正規表現で書く
- `Skill(review)`（`/code-review` の別名。skills.md:899）と、入れ子の verify（`Skill(verify)` は入れ子の名前にも当たる: skills.md:900）が、実際に上の `if` に当たるかは smoke test で確かめる
- `if` はベストエフォートなので、`commit` の処理は「HEAD が、台帳に記録済みのどの SHA とも違い、コミットの時刻が直近である」ことを自分で確かめてから行を書く。`if` に当たらなかったコミット（`git -C`、スクリプト経由、利用者の `!` コマンド）は `report` の突き合わせで数える
- 判定（コミット 1 件ごと）:
  - `paths` = そのコミットで変わったファイル（`git diff-tree --no-commit-id --name-only -r HEAD`。最初のコミットは `--root`、マージは第 1 親との差）
  - `run` = 前のコミットの後にあった、同じリポジトリでの最新の verify の記録
  - `run` がない → `none`。`git diff --name-only <run.tree> HEAD -- <paths>` が空 → `verified`。空でない → `stale`（差のあるファイルの数を残す）。`paths` がすべて docs と tests の glob に当たる → `skipped`
  - あわせて `session_verify`・`session_code_review`（同じ session_id で実行があったか。記事の基準）を記録する
- ツリーのハッシュは、本物の index を一時ファイルにコピーし、`GIT_INDEX_FILE` を差し替えて `git add -A` と `git write-tree` で求める。本物の index には触らないので、`index.lock` とぶつからない
- 台帳の行（プロンプト、コマンド、ファイル名は書かない）:
  - `{"v":1,"kind":"run","ts":…,"skill":"verify","via":"model|user","tree":"<sha>","session":"<id>","fired":["hooks-stdout"],"self_check_change":false}`
  - `{"v":1,"kind":"commit","ts":…,"sha":"<sha>","mode":"observe","result":"verified|stale|none|skipped","stale_files":0,"since_run_s":42,"session_verify":true,"session_code_review":false}`
- 設定は `~/.claude/verify-layer/config.json`（`mode`、`skipGlobs`、`timeoutMs`）。既定は `observe`。`off` なら何も書かない

### 5.2 置き場所

**新しい独立リポジトリ `claude-verify-layer` にする。**

- sample-harness は「タスクグラフの実行と検証」の道具で、導入先に入っているとは限らない。混ぜると、片方だけを入れる・外すことができなくなる
- agent-harness-eval は汎用の評価器として保つ。この層の評価タスクは新しいリポジトリの `eval/` に置き、AHE にはそのパスを渡して実行する（タスク置き場を指定する CLI の引数名は実装時に確かめる）
- wikiskill、lean-agent-skill、cc-review-tool-eval、codegraph-harness は目的が違う
- この環境では wikiskill や agent eval と同じく ZIP で入れるので、単体で完結したリポジトリのほうが扱いやすい

### 5.3 ディレクトリ構成

```
claude-verify-layer/
├── README.md                    # 何をして、何をしないか。台帳の読み方
├── INSTALL_FOR_CLAUDE.md        # 導入先の Claude Code が読んで導入する手順（5.4）
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json         # 展開したディレクトリをローカルのマーケットプレイスとして追加するため
├── hooks/hooks.json             # 5.1 の配線（プラグイン形式）
├── scripts/
│   ├── vl.js                    # 入口: hook run|commit|expand / report / doctor / checklist
│   └── lib/                     # git.js ledger.js classify.js checklist.js glob.js config.js（Node の標準機能だけ）
├── install/
│   ├── hooks.settings.json      # プラグインを使えない環境向けの雛形（絶対パスに置き換えて使う）
│   └── settings-merge.js        # 冪等なマージ、--check、--uninstall、バックアップ
├── rules/verify-layer.md        # Rules の 2 行（直接配布用）
├── templates/checklist.json     # 最初の項目（ハーネス自身の過去の不具合から）
├── docs/ledger-format.md
├── test/                        # node:test。一時的な git リポジトリを作って試す
└── eval/                        # AHE 用のタスク・プロファイル・採点スクリプト・fixture（5.6）
```

前提にするのは Node 18 以上（`node:test` のため）と git 2.30 以上で、npm の依存パッケージは持たない。

### 5.4 INSTALL_FOR_CLAUDE.md の要件

導入先の Claude Code がこの文書を読み、環境に合わせて導入する。**検出は読むだけ → 結果と案を利用者に見せる → 承認を得てから書く**、の順を必ず守らせる。

1. **環境の検出（読むだけ）**
   - `claude --version`: 2.1.286 未満なら、標準の指示がないので verify の実行率は 0 になる、と伝える（台帳は入れられる）
   - OS と、Git Bash の有無、PowerShell ツールの有無（`CLAUDE_CODE_USE_POWERSHELL_TOOL`、`CLAUDE_CODE_USE_BEDROCK` かどうか）
   - `node --version` と `git --version`。Node がなければ導入をやめ、理由を伝える
   - 推論の経路（`CLAUDE_CODE_USE_BEDROCK` など）
   - 管理設定ファイル（macOS は `/Library/Application Support/ClaudeCode/`、Linux は `/etc/claude-code/`、Windows は `C:\Program Files\ClaudeCode\`）の `allowManagedHooksOnly`、`strictPluginOnlyCustomization`、`disableAllHooks`、`includeGitInstructions`、`skillOverrides`、`enabledPlugins`
   - ユーザーとプロジェクトの settings: 上と同じキー、`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`、既存の hook（特に PreToolUse と PostToolUse の Bash、Skill、UserPromptExpansion）
   - 名前が `verify` または `simplify` のスキル・コマンドが、個人用やエンタープライズの場所にないか（あれば、全リポジトリの記録を上書きする）
   - ECC の gateguard などの、コミットに反応する既存 hook。プラグインを配る経路があるか
2. **経路の選び方**
   - `allowManagedHooksOnly` がある → 自分では入れず、管理者向けの設定の断片を出力して終える（管理設定で強制有効にしたプラグインの hook だけが動く: hooks.md:259）
   - プラグインが使える → A: プラグインとして入れる（導入先の方式に合わせる）
   - プラグインが使えない → B: `install/settings-merge.js` で `~/.claude/settings.json` にマージする
   - `strictPluginOnlyCustomization` がスキルを含む → プロジェクトの verify が読み込まれない。台帳は入れられるが、verify の実行率は 0 になる、と伝える
3. **既存の設定を壊さないマージ**
   - JSON として読んで書く。文字列の置換はしない。読めなければ止める
   - 自分の hook は、コマンドの引数にある `vl.js` の絶対パスだけで見分ける（sample-harness の前例）。自分の分を外してから入れ直すので、2 回実行しても同じ結果になる
   - 他人の hook の削除・並べ替え・書き換えをしない。ECC などを無効にするのは提案にとどめる
   - 書き込む前に差分を見せ、タイムスタンプ付きのバックアップを取る。`--check` は読むだけ
4. **観察モードが既定**: `config.json` は `{"mode":"observe"}` で作る。enforce は初版にはない
5. **Rules**: `rules/verify-layer.md` を `~/.claude/rules/` に置く。既存の Rules のファイルは編集しない
6. **導入後の確認**
   - `node vl.js doctor`: 検出した条件の再確認と、各 hook に hooks.md の例と同じ形の擬似入力を流し、終了コード 0 と出力の形を確かめる
   - 任意で、使い捨てのリポジトリで 1 回だけ実際のセッションを動かし、台帳に run と commit の行ができるかを見る（モデル費用はこの 1 回だけ）
   - 各リポジトリへの導入手順: `/verify` を 1 回実行し、記録された `.claude/skills/verify/SKILL.md` をコミットする。続けて 2 回実行し、結果が同じかを見る
7. **アンインストール**: 自分の hook だけを外し、プラグインを外し、`~/.claude/verify-layer/` と Rules のファイルを消す。各リポジトリの台帳（`.git/claude-verify/`）は、消すかどうかを利用者に聞く。バックアップから丸ごと戻すことはしない（導入後に、ほかの変更が入っているかもしれないため）
8. **してはいけないこと**: `.claude/skills/verify/` に書く。個人用の場所に `verify` を置く。プロンプト、コマンド、ファイル名を台帳に書く。利用者の承認なしに設定を書く

### 5.5 テスト方針

- **単体テスト**（`node:test`、テストの中で一時的な git リポジトリを作る）
  - 判定: verified、stale（verify 後の編集）、none、skipped、verify の開始後に `SKILL.md` だけが書かれた場合（コミットに含まれなければ verified になること）、未追跡のごみファイルがある場合
  - git の形: 最初のコミット、worktree（`.git` がファイル）、detached HEAD、`--amend`、マージコミット、`git add -A && git commit && git push` のような連結
  - チェックリスト: 作業ツリー側だけ書き換えても結果が変わらないこと。ファイルがない、壊れている、正規表現が不正なとき（何も出さず、台帳に警告の件数だけを残す）。glob はパスの区切りを `/` にそろえる（Windows 向けに `path.win32` でも試す）
  - 秘匿: 入力の `prompt` に目印の文字列を入れ、台帳に出てこないことを確かめる
- **hook の約束事のテスト**: イベントごとに hooks.md の入力例を流し、終了コード 0、stdout は空か正しい JSON、`decision` を出さない、1 秒以内（1 万ファイルのリポジトリで計る）
- **インストーラのテスト**: 空の settings、ECC 相当の hook を含む settings、既に PostToolUse の Bash がある settings で、2 回続けてマージしても同じになること、`--check` が書かないこと、アンインストール後にほかの部分が意味として同じであること
- **実機の smoke test**（モデルを呼ぶのは最小限。haiku で 1〜2 回）: この環境の 2.1.325 で、PostToolUse(Skill verify)、`/verify` を打ったときの UserPromptExpansion、`Skill(review)` の別名、PowerShell の `if` 以外の配線が実際に発火するかを確かめる。導入先の 2.1.321 でも、INSTALL の手順 6 で同じことをする
- **Windows**: 手元に端末がないので、`path.win32` の単体テストと、最初の Windows 利用者向けの確認手順（観察モードなので害はない）で補う

### 5.6 agent-harness-eval での with / without 評価

AHE 0.8.0 の、実在する仕組みだけで組む: タスクの YAML、プロファイル（`install` で `{config_dir}/settings.json` などをコピー）、`command` と `llm` のグレーダー（`TRIAL_RECORD` で tool_calls の順番が読める）、`--trials`、`--baseline`、`split`、`promote`、`--monthly-budget-usd`。

**足りないものと回避策**: タスクごとの git の準備を書くキーがない。fixture に `_git/` として履歴を入れ、全プロファイル共通の `install` の `run` で `{workdir}/_git` があれば `.git` に名前を変える（なければ何もしない）。長い目で見れば、AHE のタスクに `setup` キーを足すほうがよい（AHE 側の別の変更）。`hook_used` はハーネスなしとの Δ から外される（`spec.py:115`）ので、比較には使わず、配線の確認にだけ使う。

#### 評価 E1: コミット前の確認（関門とチェックリストの効き）。この層の本体

- **タスク**: 既知の不具合 5 件（stderr への通知、`classifyDestination` の振り分け、参照されない tier タグ、モデルに届かない案内文、`git_commit` の無条件更新）ごとに、それを再び入れやすい小さな変更依頼を作る。たとえば「hook X に利用者への通知を足して、コミットして」。fixture は小さなリポジトリで、記録済みの `.claude/skills/verify/SKILL.md` と、HEAD にコミット済みの `checklist.json` を、全プロファイルで共通に持つ。加えて、どの項目も発火しない対照の依頼を同じ数だけ作る
- **正解キー**: 文ではなく**隠しテスト**にする。`eval/checks/` に置く採点スクリプトが、コミットされた HEAD で、その不具合が再び入っていないかを決定的に調べる（fixture の外にあるので、エージェントからは見えない）
- **グレーダー**:
  1. `command`: 隠しテスト（重み 2）
  2. `command`: コミットができているか
  3. `command`: `TRIAL_RECORD` で `Skill(verify)` が最後の `git commit` より前にあるか。標準の指示が守られた割合を、両方のプロファイルで測る
- **プロファイル**: P0 = 層なし。P1 = 台帳だけ（チェックリストの hook を切る）。P2 = 台帳とチェックリスト
- **試行数**: 1 タスク・1 プロファイルあたり 3 回（記事の「3 回中 2 回で検出できる」に合わせる）。10 タスク × 3 プロファイル × 3 回 = 90 回。費用は先に `plan` で見積もり、`--monthly-budget-usd` で上限をかける
- **採否の基準**:
  - P1 対 P0（観察の台帳を配ってよいか）: 隠しテストの合格率で後退したタスクが 0、ターン数と費用の増加が 5% 以内。満たせば、自分の環境での観察を始めてよい
  - P2 対 P1（チェックリストを配ってよいか）: 罠のあるタスクで「改善したタスク数 > 後退したタスク数」、対照で後退 0。holdout が 20 件に届くまでは、自分の環境でだけ使う。20 件そろったら `promote --candidate P2 --incumbent P1 --max-regressions 1` で判定する
- **分割**: family は不具合の種類ごとに分け、1 つの family を 1 つの split にまとめる（同じ family が複数の split にまたがると `_split_warnings` が警告する。同じ不具合の亜種が train と holdout に分かれて漏れるのを防ぐため）

#### 評価 E2: レビュアーの再現率（`/code-review` と、CLAUDE.md の「重視する点」の節）

- **正例**: ハーネスのリポジトリの fix と revert から、不具合を入れたコミットを特定する。そのコミットを HEAD にした fixture を作り、プロンプトは `/code-review HEAD~1..HEAD`（`-p` では前景で動き、指摘が応答に入る: code-review-local.md:111）
- **正解キー**: 1 文と、ファイル名
- **グレーダー**:
  - 主: `command`。cc-review-tool-eval の `MATCH` と同じく、不具合ごとの同義語グループがすべて当たり、ファイル名も出たときだけ合格にする。決定的に判定できる
  - 副: `llm`（criteria に正解キーを書く）。主と食い違った試行は人が見て、`calibrate` で判定モデルの一致率を出す
- **対照**: 大きさをそろえた、その後問題が出ていない変更。Important に当たる指摘が 0 件なら合格。nit と pre-existing は別に数える
- **プロファイル**: P0 = 同梱の `/code-review` だけ。P1 = それに CLAUDE.md の節を足す
- **試行数**: 3 回。2 回以上で見つけたものを「検出できる」とする
- **採否**: 正例が 20 件に届くまでは採否を決めず、「どの不具合を取りこぼしたか」の記録にする（設計どおり）

#### 実際のバグの正解キーが足りないときの代わり

近い順に次の 3 つ。

1. **自分のリポジトリの fix コミットを掘る**: $E1B_REPOS_DIR/ の 6 リポジトリの `fix:` と revert から、不具合を入れたコミットを特定する。本物の不具合なので一番近い。限界: 件数が読めず、特定に人手がかかる。正解キーの文は fix のコミットメッセージに引きずられる
2. **cc-review-tool-eval の 12 件**（`bench/defects.json` と `MATCH` をそのまま使える）: 限界: 合成のリポジトリに仕込んだ欠陥で、ファイルをまたぐ種類に偏っている。対照がないので、同じリポジトリの問題のない変更を足す必要がある。評価のプロンプトは網羅を優先するよう指示しており、確信の高い指摘だけを出す `/code-review` とは前提が違う
3. **公開 OSS の fix を逆に当てる**（fix を戻して、不具合を入れる diff を作る）: 限界: fix の逆は、もともと不具合を入れた変更より小さく、怪しさが目立つので、再現率が高めに出る。学習データに含まれている恐れがある。導入先のコードの性質を表さない

どれを使っても、**記事の「生の指摘・検証後・最終」の段階ごとの再現率は測れない**（同梱のレビューの中は見えない）。測れるのは最終の出力だけ。

### 5.7 段階

| 段階 | 内容 | 次に進む条件 |
| --- | --- | --- |
| 0 | v0.1 を自分の環境に入れ、2 週間観察する。`report` で、台帳に拾えた割合、結果の内訳、stale の大きさ、verify の実行率、hook の p95 時間を見る | 台帳に拾えた割合が 90% 以上。hook の p95 が 1 秒未満 |
| 1 | E1 と E2 を回す。チェックリストを自分のリポジトリで使う | 5.6 の基準 |
| 2 | enforce を作る（PreToolUse の deny、`Unverified-Reason:`、同じ session_id で 2 回止めたら通す、gateguard の deny とは分けて数える） | 観察で「止めていたはず」のうち、誤りが 10% 未満（20 件を人が見る） |
| 3 | 導入先のエンジニアに observe で配る。掘り起こしと刈り込みを月 1 回、手で回す | — |
| 4 | SQL 向け（プロジェクトの `verify` か、別名のスキル） | Trino で小さく試せる場所が決まること |

## 6. 未解決リスク

| # | リスク | 影響 | 当面の扱い |
| --- | --- | --- | --- |
| 1 | コミット前の指示は、文書と changelog に加えて、バイナリの中の文面とフラグ `tengu_polished_tulip`（既定は on）に依存する。Bash ツールの説明文の 1 文にすぎない | 版が上がると、文面や条件が知らないうちに変わりうる | `doctor` は文書にある条件だけを確かめる。台帳の「verify の実行率」が急に落ちたら、まず版の変化を疑う |
| 2 | 実行の記録は「verify を始めた時点」のもの。終わったか、通ったかは分からない | verify 中に直したコミットが stale に数えられる。逆に、失敗した verify の後でも verified になりうる | 判定の対象を、コミットに含まれるファイルに絞って誤判定を減らす。enforce の前に、観察の結果を 20 件、人が見る |
| 3 | `if` はベストエフォート。`git -C`、スクリプトや alias 経由のコミット、利用者の `!` コマンドは拾えない | 台帳に拾えない割合が分からないまま残る | `report` で `git log` と突き合わせる。attribution の trailer を切っている環境（Riku の環境もそう）では Claude のコミットを見分けられないので、推定値になる |
| 4 | Node が入っていない端末がある（Claude Code 本体はネイティブのバイナリ） | hook が起動せず、`onFailure: "continue"` で黙って素通りする | INSTALL で検出して止める。`doctor` で起動を確かめる |
| 5 | 管理設定（`allowManagedHooksOnly`、`strictPluginOnlyCustomization`）が、手元でどう設定されているか分からない | 自分では入れられない、または verify の実行率が 0 になる | INSTALL で検出し、管理者向けの断片を出して終える |
| 6 | UserPromptExpansion を追加した版が changelog にない。導入先の 2.1.321 で発火するか未確認 | 利用者が打った `/verify` が記録されず、none が増える | 導入先の smoke test で確かめる。動かなければ、PostToolUse(Skill) だけで記録し、その旨を `report` に出す |
| 7 | ECC の gateguard など、ほかの PreToolUse の deny と並ぶ | enforce を作るとき、拒否の理由が 2 つ並び、「2 回止めたら通す」の数え方がずれる | 初版は PostToolUse だけなので影響なし。enforce では、自分の deny だけを session_id ごとに数える |
| 8 | 正解キーが 5 件しかない。判定モデル（既定は haiku）の偏り | 採否を統計的に決められない。過学習の恐れ | 20 件そろうまでは記録として扱う。グレーダーは決定的な照合を主にし、LLM の判定は副にする。`calibrate` で一致率を出す |
| 9 | `/code-review` は背景で動くので、指摘が届く前にコミットが進む | 指摘がコミット後に届き、役に立たない | 台帳には「実行されたか」だけを残す。前景で動かす方法（`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`）を README に書く。既定にはしない（ほかの背景機能も止まるため） |
| 10 | 台帳は各リポジトリの `.git` の下にあり、その端末にしか残らない | チーム全体で「検証されていないコミット」を引けない（記事の stamp とは違う） | 初版はこれでよい。共有が要るなら、次の段階で `git notes`（コミットの後に別の操作として付けるので、連結コマンドで壊れない）を検討する |
| 11 | 直接コミットでは、HEAD から読むチェックリストも 1 つ前のコミットで書き換えられる | 2 段階で、自分のチェックを変えられる | 「チェックを変える変更」の警告を必ず出し、台帳に `self_check_change` を残す。人が見る |
| 12 | 文書にない `includeCodeReviewSuggestion` を使えば、`/code-review` もコミット前の指示に入る | 使えば便利だが、予告なく変わりうる | 使わない。試すのは自分の環境だけにし、結果を記録する |
| 13 | sources/ の文書は 2.1.327 時点で、導入先の 2.1.321 より新しい | 文書にある動きが、導入先の版にはまだない恐れ | 2.1 節の最低版の一覧で確かめた。どれも 2.1.321 より前。ほかは smoke test で確かめる |

## 付録: DESIGN.md に入れるべき修正（要約）

1. 「公式ドキュメントで確認したこと」の表: Windows の行を「PowerShell ツールが主シェルになり、Bash だけの matcher は発火しない」に直す。`if` の行に `PowerShell(...)` を足す。Stop hook の行に `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` を足す。verify 指示の行に、指示が消える条件（`skillOverrides`、`strictPluginOnlyCustomization`、bare、`--safe-mode`、環境変数）を足す
2. 実行の記録: 「始めた時点のツリー」と明記し、判定をコミットに含まれるファイルの差に変える。`/code-review` の実行も記録する
3. 関門: 初版は PostToolUse の観察だけにする。PreToolUse の enforce は第 2 段にする
4. テレメトリ（OTEL）と「v0.5 の内容を含まない信号」の記述を消し、ローカルの `report` に置き換える。AHE の版を 0.8.0 に直す
5. チェックリストの形式を JSON にし、`owner`・`why` を足す
6. SQL 向けの個人用 verify を「採らなかった案」に移し、理由を書く
7. 「安いチェックから先に」と、Stop hook を採らなかった理由を、第 1.1 節のとおりに直す
8. 出典の「節ごとの要約を使用」を、全文と照合した旨に直す
