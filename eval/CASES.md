# 正解キーの出どころ（実際のバグ 4 件と、対照 4 件）

手元のリポジトリと公開の agent-harness-eval の fix コミットから、次の条件で 4 件を選びました。

- **diff から見分けられる**: 不具合を入れる変更に、機械的に拾える形（subprocess の呼び出し、`stat` でのサイズ検査、記録の辞書への追記、状態の `==` 比較）がある
- **コードを読むだけでは気づきにくい**: 開発環境（UTF-8、通常のファイル、成功の経路）では、通常のテストが通り続ける
- **決定的に判定できる**: 隠しテストが、依存するモデルや時刻なしに、再発の有無を 1 回で判定できる（Windows 固有の競合などは除外した）

fixture は元のコードではなく、**不具合の型を小さな Python ライブラリに作り直したもの**です（各 fixture の README とコードは合成。元のリポジトリの内容は含まない）。依頼文は、不具合を入れる自然な実装を誘うもので、不具合を直接頼んではいません。

| タスク | 元の fix | 不具合（1 文） | 再び入りやすい依頼 | 隠しテストが見るもの |
| --- | --- | --- | --- | --- |
| `trap-locale-decode` | sample-harness `a100007` | git の出力を `text=True` だけで復号すると、Windows の locale（cp932 など）で非 ASCII のファイル名が化け、変更が見えなくなった | 「git を呼んで、HEAD から変わったファイルの一覧を返す `changed_files(repo)`」 | `LC_ALL=C`・`PYTHONUTF8=0` の環境で、`メモ.txt` などの一覧が正しく返る |
| `trap-fifo-bounded-read` | sample-harness `a100006` | 信頼できないファイルを `stat` のサイズで検査して読むと、FIFO（サイズ 0）が検査をすり抜け、`open` が永久に止まった | 「1 MiB を超えるファイルは拒否する `load_tasks(path)`」 | FIFO（書き手なし）を 8 秒以内に拒否する。1 MiB ちょうどは読め、1 MiB + 1 は `StoreError` |
| `trap-rejection-leak` | agent-harness-eval `37f2e60` | 見送った提案の本文（old / new / reason / notes）が improve.json に残った（元の依頼の写しを含みうる） | 「improve.json に `n_deltas` と `reasons`（id → reason）の欄を足す」 | 見送りの improve.json と戻り値に、本文の目印の文字列がない。通過の記録には `reasons` と本文がある |
| `trap-drift-scope` | sample-harness `a100005` | `--check` が文書全体を比べ、他のツールが追記した hook の位置だけで、恒常的に「ずれ」扱いになった | 「settings.json に管理する hook が入っているかを調べる `check(settings_path)` と cli の `check`」 | 他ツールの hook を前・後に足す、別のイベントに足す、無関係なキーを足す、整形し直す → ずれなし。timeout の変更・削除・重複・ファイルなし → ずれあり。`check` は書き換えない |

対照（どのチェックリスト項目も発火しない、純粋な関数の追加か文字列の整形の変更。後退がないかを見る）:

| タスク | 依頼 | 隠しテストが見るもの |
| --- | --- | --- |
| `ctrl-format-size` | `format_size(n_bytes)`（KB / MB / GB の表記） | 7 つの値の表記 |
| `ctrl-oldest-open` | `oldest_open(tasks)` | 完了でないタスクのうち最古の 1 件、なければ None |
| `ctrl-format-problems` | `format_problems` を番号付きの複数行に | 2 件・1 件・空 |
| `ctrl-managed-events` | `managed_events()` | 名前順のイベント名 |

## 検証（モデルを呼ばない。`tools/selftest.sh`）

各タスクについて、`reference/<task>/` の参照解を使って確かめています（参照解は人が書いた解で、エージェントの出力ではない）。

- 変更なしの HEAD → 隠しテストは落ちる（機能がない）
- 罠: 不具合入りの参照解 → 落ちる（再発を検出）。修正済みの参照解 → 通る
- 対照: 参照解 → 通る
- 罠の diff では狙いの項目が（不具合入り・修正済みの両方で）発火し、対照の diff では何も発火しない（実際の hook `vl.js hook skill` を通して確認）

## 限界（読む人へ）

- **チェックリストの正規表現は、この 4 件を知ったうえで書いた**。実際の導入では、事故のあとに書いた項目が、次の別の変更に当たる確率はもっと低い。P2 の発火は、この評価では有利に出る
- 罠は 4 件、対照は 4 件。1 つの不具合の型ごとに依頼が 1 つだけで、依頼の書き方に結果が左右される
- 隠しテストは、参照解の 2 通り（不具合入り・修正済み）だけで検証している。ほかの正しい（または誤った）実装を、誤判定する可能性が残る。結果を見るときは、不合格の試行の理由欄（`FAIL …`）を数件読むこと

## E1b の続き（2026-11-19 02:35 JST、Claude の 5 時間枠が上限で中断。リセット 06:40 JST）

済み（93dd300, 996fb36）: E1b の罠 6 件（実リポジトリの写し: sample-harness 4 件・wikiskill 1 件・llm-news 1 件。チケット風の依頼に 3〜5 個の作業を並べ、罠は 1 つ）、`checks/hidden_e1b.py`・`checks/e1b/`、参照解 `reference-e1b/`、プロファイル `profiles-e1b/`、`tools/selftest-e1b.sh`（全部 ok）、`run-eval.sh {smoke|full|dry} e1b` と `smoke-p0`。`run-eval.sh dry e1b` 30/30、E1 の dry 24/24・selftest も ok、`npm test` 104/104。
残り（新しいセッションで）:
1. この CASES.md に E1b の出どころ表（タスク、元の fix SHA、不具合 1 文、依頼のどこが罠を誘うか、隠しチェックが見るもの、気をそらすもの）を追記。README に E1b の節（実行方法、**判定基準は RESULTS.md の事前固定の節をそのまま使う**こと）
2. 外側のシェルで `./run-eval.sh smoke-p0`（P0 × 罠 6 × 1 回）。ベースラインの合格が 30〜70% にない場合は罠を調整してから full
3. 範囲内なら `./run-eval.sh full e1b`（(6 罠 + 対照 4) × 3 × 2 = 60 試行）→ 集計 → RESULTS.md に E1b の結果

## E1b: P0 のスモークで罠を避けられた理由と、難しくした内容（2026-11-19）

スモーク `eval-out/smoke-p0-e1b/20261119-091949-848-a2`（claude sonnet、P0、1 回ずつ）の合格は 5/6 で、目標の 30〜70% を上回った。HEAD のチェックリスト（`.claude/verification/checklist.json`）を読んだのは、不合格だった trap-stop-hook-decode の 1 試行だけ。合格した 5 件はチェックリストを読んでいない。

### 合格した 5 件が罠を避けられた理由（作業ツリーとトランスクリプトから）

- **trap-csv-roundtrip**: 依頼文の「読み込んだ結果は、書き出したときの内容と一致していてください」が、罠の性質（往復の一致）をそのまま書いていた。試行は、先頭が `'` の値にも印を付け、印の次が危険文字か `'` のときだけ外す形を最初から書いた。これは元の fix と同じ形。
- **trap-rejected-submit**: fixture の `submit` が、すべての検査を終えてから書き込む並び（fix 後の形）に整えてあった。検査を足す自然な位置（状態の検査の直後）が、もともと書き込みより前だった。既存の `_same_actor`（withdraw が使う）も、そのまま使えた。
- **trap-reviewer-identity**: 依頼文の「ID は各自が CLI の引数に手で入れています」が、表記の揺れを示していた。試行は strip と casefold をしてから比べ、理由にもこの点を挙げた。隠しチェックは、実行者の側の揺れ（元の事故の形）を見ていなかった。
- **trap-text-of**: 依頼文に、症状（全件が other、TLDR が空、モデルは正しく答えている）と、SDK のメッセージの形（AssistantMessage の後に ResultMessage）が書いてあった。試行は「ResultMessage は直前の文の繰り返し」と述べ、result を優先する形にした。
- **trap-wait-superseded**: 罠の行（待ち先の一覧）を新しく書かせる依頼で、すぐ隣に `SETTLED`（verified と superseded）と、それを使う昇格の判定があった。試行は昇格の判定を読み、同じ定数を使った。依頼文の「今も待っている」も、済んだ依存先を除くことを示していた。

### 変えたこと（7676054 と、その後の 5 コミット）

どの罠も、作業を 4〜5 個にして、罠の作業を 3 番目に置いた。罠以外の作業には、隠しチェックの sub 項目を 1 つずつ足した。selftest（不具合入り → 罠の項目だけ落ちる、修正済み → 通る、狙いの項目が発火する）は全部 ok。

| タスク | 変えたこと | 罠に入る道筋 |
| --- | --- | --- |
| `trap-csv-roundtrip` | 依頼文から、往復の一致を求める文を除いた（頼むのは「数式として実行されない」ことだけ）。`review-apply` の内訳に `unknown_rows` を足す作業を加えた | `review-apply` がシートを読み戻して tasks.jsonl に入れることは、既存のコードと README から分かる。元のリポジトリでも、a10000b で印の付け外しが入り、a10000d で `'` で始まる値の往復が直された。印だけを付ける実装と、元と同じ付け外しの実装は、どちらも `"'=x"` などで落ちる |
| `trap-rejected-submit` | fixture の `submit` を、元の a100003 の並び（証拠の代入が review_context の検査より前）に戻した。不具合入りの参照解は、元のコードそのもの。`validate` の `edges` を足す作業を加えた | 既存の検査（review_context）が書き込みの後にあるので、その並びに actor の検査を足すと、拒否された提出の証拠が残る。CLI は失敗時に保存しないため、見える側のテスト（CLI 経由）では気づけない |
| `trap-reviewer-identity` | 依頼文から、ID の入れ方のヒントを除いた。隠しチェックに、実行者の側に末尾の空白や大文字がある場合（元の事故: executor が `"agent-1 "`、reviewer が `"agent-1"`）を足した。`ready` の `count` を足す作業を加えた | fixture の submit と withdraw には、元のままの素の比較（`actor_id != node.get("executor_id")`）がある。それを手本に写すと、表記を変えるだけで同じ人がレビューを通せる |
| `trap-text-of` | 依頼文から、症状の報告と SDK のメッセージの形の説明を除いた。代わりに、fixture の `text_of` に、元の a10000c の docstring の文（`ResultMessage` の `.result` は "the final answer — observed 2026-05-16 to carry the model's JSON/prose"）を TODO として置いた。sub 項目として、ResultMessage だけに回答がある流れも見る（元の fix の代替の経路） | docstring の "Flatten" と TODO のとおりに、TextBlock と result の両方を連結すると、JSON が二重になる |
| `trap-wait-superseded` | fixture の `_next_action` を fix 前のまま（`!= "verified"`）に戻した。依頼は「ダッシュボードが `next_action` の文字列を解析しているので、構造化した `waiting_on` を足す」にした。`ready --role` の作業を加えた。`next_action` の文字列（fix 前の不具合を含む）は依頼の範囲外なので、判定しない | 隣の比較を写すと、元の不具合が新しく書いた行に入る。最初に試した「`next_action` に状態を添える」案は、不具合入りの diff が比較の行に触れず、チェックリストが発火しなかった（P2 が効く機会がない）ので採らなかった |
| `trap-stop-hook-decode` | 変えていない（ベースラインが不合格だったため） | — |

新しい罠（同じリポジトリの別の fix コミットから）は足していない。まず 6 件の調整で、30〜70% に入るかを見る。

### そのほか

- fixture の `examples/task-graph.json` と `examples/quickstart/task-graph.json`（sample-harness の 4 つの fixture で計 8 ファイル）が、共有の `.git/info/exclude`（`task-graph.json*`）に当たって git に入っていなかった。新しい checkout では、sample-harness の 4 つの fixture で見える側のテストが落ちていた（7676054 で追加）。selftest-e1b に、git に入っていない fixture のファイルを検出する確認を足した。スモークは、ファイルのある元の checkout で実行したので、結果は有効。

### 限界（追加）

- 依頼文からヒントを除いたので、隠しチェックが求める振る舞いの一部は、依頼文には書いていない。既存のコード・README・元の fix の判断に基づく（表記の揺れだけが違う ID は同じ人とみなす、superseded の依存先は待たない、シートは読み戻しで元の値に戻る）。不合格の理由欄を読むときは、「仕様を読み落とした」のか「依頼文から決められなかった」のかを分けて書く。
- チェックリストは全プロファイルの HEAD にあり、事故の説明（`incident`）が書いてある。P0 も読めば答えが分かる（スモークでは、trap-stop-hook-decode の試行が読んだ）。設計どおり（P0・P1・P2 で HEAD を同じにする）なので、変えていない。

### 続き

1. 外側のシェルで `./run-eval.sh smoke-p0` をもう一度回す（P0 × 罠 6 × 1 回）。合格が 2〜4 件（30〜70%）に入れば、`./run-eval.sh full e1b` へ進む。外れたら、不合格・合格の理由欄を読んで再調整する（0〜1 件なら、上の限界の 1 つ目に当たる罠から、ヒントを戻すことを考える）
2. full の後、集計して RESULTS.md に E1b の結果を書く（判定基準は RESULTS.md の事前固定の節をそのまま使う）
