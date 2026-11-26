---
name: verify2
description: Verify v0.2 の依頼でコードや設定を変更したときに、壊れやすい境界入力を公開入口で前後比較し、最終状態の検証結果を記録する。
---

# verify2

依頼開始 hook から渡された依頼 ID、ホスト、セッション ID、`vl.js` のパスを使う。開始記録がない場合は、依頼開始時の状態を確認できなかったと報告する。

## 境界ケースを作る

1. 依頼文と参照を許可された資料から、期待結果が一意に決まる境界候補を 3〜5 件挙げる。バグ報告に再現条件があれば最初に置く。サイズ、空・端値、表記、順序、失敗応答などを調べ、現実装が最も誤りやすい 1 件を選ぶ。依頼文や既存公開テストの例と同じ入力は `nonBoundary: true` にする。
2. 公開入口を import し、1 ファイルに標準ランナーで実行できるテストを 1 件書く。Python は `test_vl_<request_id>_<slug>.py`、Node は `<slug>.vl_<request_id>.test.js` または `.mjs` を使う。準備を先に済ませ、テスト本体の直下で指定 assertion を 1 回実行する。実測側では import した入口を名前またはリテラル引数で直接呼ぶ。期待値側はリテラル、またはリテラルを一度だけ束縛し指定 assertion にだけ使う名前にする。ループ・分岐・例外の握りつぶし・skip・パッチ・引数展開を避ける。
3. 入口が新設の場合は、追加を求めた依頼の一文を `entryAdditionQuote` にそのまま書く。依頼全体で配置先が指定されていればロード先をすべての指定に一致させる。検出する語順の例は「新しい関数 `name` を追加する」「`name` 関数を新設する」「`name()` を追加する」「モジュール `name` を作成する」「`pkg/name.py` を作成する」「add a new function name」。種別語は関数・メソッド・クラス・API・入口、モジュール・パッケージとそれぞれの英語。追加の語は追加・新設・作成・実装・用意・公開、および add・create・implement・introduce・expose・provide。しない・せず・不要・禁止・既存、not・without・no・existing などを含む文や、種別やコード表記を伴わない名前の追加は入口新設の証拠にならない。

使える比較の形

- pytest は `assert api(x) == "value"`、`assert api(x) is None`（`True`、`False` も可）、または `with pytest.raises(ValueError):` の中に `api(x)` を 1 文。
- unittest は `self.assertEqual(api(x), "value")`、`self.assertIs(api(x), None)`（`True`、`False` も可）、`self.assertIsNone(api(x))`、`with self.assertRaises(ValueError):` の中に `api(x)` を 1 文、または `self.assertRaises(ValueError, api, x)`。
- Node は最初の文を `t.plan(1)` にし、`t.assert.strictEqual(api(x), "value")`、`t.assert.deepStrictEqual(await api(x), "value")`、`t.assert.throws(() => api(x), TypeError)`、または `await t.assert.rejects(api(x), TypeError)`。

## ケース JSON と前後比較

`input.args` は位置引数順、`input.kwargs` は渡す順の `[名前, 型付き値]` の配列（Node は空配列）。各値は `{"type":"str","value":""}` の形にし、辞書・オブジェクトの `value` も項目順の `[キー, 型付き値]` の配列にする。Python では組み込み型そのもの、Node では凍結・拡張不可・書き込み不可・アクセサ・Symbol キーのない通常の配列・オブジェクトを使う。可変コンテナの参照を共有しない。例外を期待する場合、`expected` は `{"kind":"exception","type":"TypeError"}` の形にする。

`inputFiles` には前後で同じ内容・権限ビットにする新規データファイルや既存の非保護データファイルを、コピー内の相対パスで列挙する。対象がない場合は空配列にする。ソース・テスト設定・保護パスは指定できない。実行中に参照したコピー内パスは、一覧取得・アクセス権限確認・削除などの操作や子プロセスの参照も含め、前後の初期状態が同じ必要がある。参照記録を取得できなければ未検証になり、登録時には各パスの初期状態も固定される。

架空の Node ケースの例。追加テストのファイル位置、テスト名、assertion の開始行、依頼 ID は実際のものに合わせる。Node の入口は ESM の名前付き import または相対パスを指定した CommonJS の分割代入で束縛する。

```js
import { test } from 'node:test';
import { label } from './label.mjs';
test('empty label', (t) => {
  t.plan(1);
  t.assert.strictEqual(label(''), '(empty)');
});
```

```json
{
  "caseId": "empty",
  "candidates": [
    {"id":"empty","requestQuote":"空の入力を処理する","input":"","boundaryKind":"空","handled":false},
    {"id":"space","requestQuote":"空の入力を処理する","input":" ","boundaryKind":"表記","handled":true},
    {"id":"one","requestQuote":"空の入力を処理する","input":"a","boundaryKind":"最小文字数","handled":true}
  ],
  "selectedCandidateId": "empty",
  "selectionReason": "要素がない場合の処理が見当たらない",
  "entry": {"module":"./label.mjs","symbol":"label","call":"label"},
  "input": {"args":[{"type":"str","value":""}],"kwargs":[]},
  "expected": {"kind":"value","value":{"type":"str","value":"(empty)"}},
  "inputFiles": [],
  "testFile": "label.vl_req_a1b2c3d4e5f6.test.mjs",
  "testId": "empty label",
  "assertion": {"line":5},
  "nonBoundary": false
}
```

```sh
node "<vl.js のパス>" verify-diff --agent "<ホスト>" --session "<セッション ID>" --request "<依頼 ID>" --case "<ケース JSON のパス>"
```

依頼ごとに異なるケース ID は最大 3 件。入口到達後の比較失敗が台帳に登録されたら、入力、比較、テスト内容、入力ファイル、参照したパスの初期状態を保って実装を直し、同じ ID で再実行する。比較内容を変える場合は新しい ID を使い、元の失敗は未解消のまま残る。期待値の誤りに気づいたときは `--case` の代わりに `--withdraw <caseId> --reason "<理由>"` を使う。取り下げは取り消せない。最終結果は「未検証（ケース取り下げ）」になり、報告には理由を含める。

最終状態で前後比較と既存公開テストの結果を確かめる。照合できない場合は未検証と理由を報告する。依頼どおりの実装が既存テストの期待値と矛盾する場合は、実装とテストを保ち、依頼文の該当箇所・失敗したテスト識別子・矛盾内容を報告する。

同じ最終スナップショットで既存公開テストの回帰が再現し、依頼との矛盾を確認した場合は、依頼用コマンドに `--intentional-change "<テスト ID>" --request-quote "<依頼文の該当箇所>" --reason "<期待値との矛盾>"` を付けて記録する。終了状態は「未検証（意図した変更）」になる。
