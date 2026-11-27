# コミット前の確認項目

コミットする前に、今回の変更に当てはまる項目があれば、その確認を済ませてください。

- [subprocess-locale-decode] subprocess の出力を text=True だけで文字列にしていないか。text=True は実行環境の locale で復号するので、git が UTF-8 で出すパスが、Windows（cp932 など）では化ける。encoding="utf-8"（と errors の方針）を明示する
  理由: UTF-8 の開発環境では再現せず、別の locale でだけ非 ASCII のファイル名が化けて、変更を見逃す
  元の事故: sample-harness a100007: git の出力を locale で復号し、非 ASCII のファイル名への編集をスナップショットが見逃していた
- [untrusted-file-bounded-read] 信頼できないファイルを読む前に、サイズだけでなく通常のファイルかどうかも確かめているか。FIFO はサイズ 0 で上限の検査をすり抜け、open が永久に待つ。開いたあとの fstat で通常ファイルかを見て、上限 +1 バイトまでしか読まない
  理由: サイズの検査だけでは、FIFO やリンクのファイルで読み込みが止まる
  元の事故: sample-harness a100006: task-graph.json が FIFO だと、validate・status・Stop hook が永久に止まった
- [rejection-path-record] 記録（improve.json など）に項目を足すとき、見送り・失敗の経路にも同じ項目が出ていないか。見送った案の本文（old / new / reason / notes）は、元の依頼の写しを含みうるので、見送りでは記録しない
  理由: 成功の経路だけを見て足した項目が、見送りの経路で記録してはいけない内容まで書き出す
  元の事故: agent-harness-eval 37f2e60: 見送った提案の本文が improve.json に残っていた
- [drift-compare-own-scope] ずれ（drift）を調べるとき、文書全体や作り直した結果との一致で比べていないか。自分が所有する項目だけを比べる。他のツールが追記した hook の位置や無関係なキーで、常にずれ扱いになる
  理由: いつも赤い検査は、誰も読まなくなる
  元の事故: sample-harness a100005: --check が文書全体を比べ、他ツールの hook の位置で恒常的にずれ扱いになった
- [hooks-stdout] モデルや利用者に届けたい通知が stdout（または JSON の出力）に出ているか。stderr に出した通知は、止めない hook では debug ログにしか出ない
  理由: stderr に出した通知は、モデルにも利用者にも届かない
  元の事故: strategic-compact の通知が約 4 か月 stderr に出ていた
- [flaky-test-hiding] flaky なテストを、skip・sleep・通るまでの再試行で隠していないか。原因が分からなければ削除し、理由をコミットメッセージに書く
  理由: 隠した flaky は、本物の不具合を見えなくする
  元の事故: 検証に関する記事の規則
