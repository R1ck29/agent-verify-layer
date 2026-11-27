# 正解キーの出どころ（実際のバグ 4 件と、対照 4 件）

R1ck29 のリポジトリ（`$E1B_REPOS_DIR/` の sample-harness、agent-harness-eval）の fix コミットから、次の条件で 4 件を選びました。

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
