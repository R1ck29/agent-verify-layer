# held-out の罠（Verify v0.2 の決定的な評価用）

- 目的: v0.2 が「有用か」を、設計に使っていない罠で決める。旧 6 罠（tasks-e1b）は dev 専用。
- **v0.2 の設計・実装の担当（feat/v0.2）には、このディレクトリを見せない**。作る担当は v0.2 の実装とは別のセッション。
- 判定の規則: [PREREG-v02.md](PREREG-v02.md)（11/19 23:1x に固定。結果を見る前。**書き換えない**）。費用の見積もりも PREREG-v02.md にある。
- 状態（2026-11-20）: **作成済み・決定的な自己確認まで済み**。罠 6・対照 3。**モデルの試行はまだ 1 回もしていない**（P0 のスモークは次の段。下の「続き」）。

## 1. 中身

| 罠 / 対照 | fixture（上流の base） | 分類 | 依頼文が頼むこと | 隠しテストの罠の項目（依頼文には書かない） |
|---|---|---|---|---|
| `trap-cache-grow-key` | cachetools 16e8889（fix 39b31bc） | 境界・勘定 | 既存のキーの値を大きくしても、収まるなら追い出さない／maxsize が負なら ValueError／docs | 収まらないとき、追い出しの途中で**更新中のキー自身**が追い出されても currsize が実際の合計と一致し、maxsize を超えない（7 クラス・乱数の操作列で不変条件） |
| `trap-cache-iter-update` | cachetools 5af4208（fix e142483） | 走査中の変更・順序 | TTLCache を走査しながら値を置き換えると 1 件で終わる報告→どのクラスでも各キーちょうど 1 回／TTLCache の repr に ttl | **TLRUCache**（ヒープを走査しているので同じキーが何度も現れる・現れない）と、走査中に新しいキーを足しても走査が終わること |
| `trap-tlru-expired-set` | cachetools 978d34d（fix c0fdf6a） | 状態・写像の契約 | maxsize が負なら ValueError／「ttu が現在時刻以前を返した値は保存されない」を docs とテストで固定 | **既存のキー**に保存されない値を入れたら、前の値も消える（新しいキーでは今のコードのままで成り立つ） |
| `trap-rr-empty-choice` | cachetools eadb91c（fix bcf9e81） | エラー処理・API の契約 | choice が呼び出せなければ TypeError／契約を守る choice（min など）なら何でも、ほかのキャッシュと同じに使える | 空のキャッシュの popitem が、どの choice（min=ValueError、next(iter())=StopIteration など）でも **KeyError** |
| `trap-weekday-at-today` | schedule a6fdc61（fix f19998b） | 時刻の境界・演算子の優先順位 | 曜日のジョブを今日のこの後の時刻に登録すると翌週になる報告→今日に／at() のエラーに受け付ける形式 | 「分が今と同じ・秒が後」の**毎日・n 日ごと・別の曜日**のジョブが 1 時間ずれない（原因は括弧のない `and … or …`） |
| `trap-running-minmax-ties` | more-itertools cb75bb9（fix d992be0） | 順序・安定性 | running_min / running_max に key（各時点の窓に組み込みの min/max を当てたものと同じ要素）／Stats.range | **同点**の要素（key が同じ・0 と 0.0）で、組み込みと同じく先に来た要素を返す（窓つきの実装は新しい方を返す） |
| `ctrl-cache-free` | cachetools 16e8889 | 対照 | 読み取り専用の `Cache.free` | （罠なし）値・期限切れ・読み取り専用 |
| `ctrl-sched-get-jobs` | schedule a6fdc61 | 対照 | `Scheduler.get_jobs(tag)` と `schedule.get_jobs(tag)` | （罠なし）全部・タグ・コピーを返す |
| `ctrl-moreit-running-sum` | more-itertools cb75bb9 | 対照 | レシピ `running_sum(iterable, *, maxlen=None)` | （罠なし）整数と Fraction で窓の和、maxlen ≤ 0 は ValueError |

すべて公開 OSS の実在の修正（cachetools・schedule・more-itertools はどれも MIT。LICENSE は一字も変えずに残す）。上流の URL・base・fix の SHA は
`reference/manifests/<fixture>.manifest.json` にだけ書く（fixture の外。解答エージェントからは見えない）。
cachetools の 3 件（c0fdf6a 6 月・39b31bc 7 月・e142483 11 月）と more-itertools の d992be0（7 月）は 2026 年の修正で、モデルの知識の範囲より新しい可能性が高い。

### 罠ごとの「なぜ難しいか」と「実務でこれを捕まえる確認」

| 罠 | なぜ難しいか | 捕まえる確認（実務） | 浅い直し（`reference/<task>/naive/`） |
|---|---|---|---|
| grow-key | 報告の症状（収まるのに追い出す）は「差分だけ確保する」で直り、その直しのテストも通る。更新中のキー自身が追い出される経路は報告にない | 不変条件のテスト（`currsize == 値の大きさの合計 ≤ maxsize`）を乱数の操作列で回す／**既存のテスト全体を走らせる**（上流の `_test_getsizeof` がこの経路を踏む） | 差分を確保するループだけ（キーが消えても差分のまま）。見える側の既存のテストでも落ちる＝全体のテストを走らせたかで差が出る罠 |
| iter-update | 報告は TTLCache だけ。TTLCache を直して報告の再現テストが通れば終わったように見える。TLRUCache は別の仕組み（ヒープ）で、別の形で壊れている | 依頼の「どのクラスでも」を、クラスごとに同じテストで確かめる（兄弟のクラスへの横展開）／走査中に足す場合に止まること | TTLCache の `__iter__` だけを、キーの写しの走査にする |
| tlru-expired | 「保存されない」を新しいキーで試すと、今のコードのままで通る（＝「もう動いている」と見える）。主張したことを、既存の状態（前の値がある）でも確かめるかが分かれ目 | docs に書いた保証（「key を引いても値が返らない」）を、前の値があるときも含めて試す（状態の組み合わせ） | docs とテスト（新しいキーだけ）を足し、コードは変えない |
| rr-empty-choice | min で試すと ValueError が出るので、それを捕まえれば直ったように見える。契約は「空でない列」だけなので、空のときの振る舞いは関数ごとに違う | 契約の境界（空）を、性質の違う複数の choice で試す／原因（choice を空の列で呼ぶこと）をなくす | 空のときだけ IndexError・ValueError を KeyError にする（StopIteration などは素通り） |
| weekday-at-today | 報告は曜日のジョブの症状。曜日の処理（「7 日以上先なら 1 週間戻す」）を直せば報告の再現は通る。本当の原因は共通の条件式で、毎日のジョブにも 1 時間のずれを起こす | 「次の実行時刻」を、単位（毎日・n 日・曜日・毎時）×（同じ分・後の秒）の表で、素朴な計算と突き合わせる | 曜日のジョブだけ「今日の曜日で時刻が後なら今日」を足す |
| running-minmax-ties | 同点のない値で試すと組み込みと合う。窓つきの実装の「同じ値を新しい方で置き換える」は、key がないと 0 と 0.0 の違いでしか見えない | 依頼の仕様（組み込みの min/max と同じ要素）を、同点を多く含む乱数の列で総当たりと比べる | 既存の比較（`<` / `>`）に key を当てるだけ |

難しさの見込み（未確認。P0 のスモークで確かめる）: grow-key は既存のテスト全体を走らせれば気づけるので、天井に近い恐れがある。
weekday-at-today も、報告を追って `next_run` を表示すると 1 時間ずれて見えるので、原因に届きやすい恐れがある。ほかの 4 件は 30〜70% を見込む。
スモークで 80% を超える罠があれば、本番の前に依頼文の手がかりを減らす（隠しテストは変えない。下の「続き」）。

### 採らなかった候補（11/19 の候補の表から）
- H1〜H5（agent-harness-eval）: 解答の隔離（bwrap）の中の Python は標準ライブラリだけ（PyYAML がない）で、AHE はどのモジュールも yaml を読み込むため、
  見える側のテストもコードも動かせない。H4（37f2e60）は E1 の trap-rejection-leak の出典でもある。
- H7（harness-sync-check の backup_tree）: この端末に元のリポジトリが見つからなかった。
- tomli（91df038 ほか）: 2021 年の版はテストが pytest（隔離の中にない）。isodate 53b2053: 2015 年の版で、修正自体も不完全。schedule 4a3b1a4: 変わるのはエラーの文言だけ。

## 2. 作り（tasks-e1b と同じ形）

```
eval/heldout/
  tasks/<id>.yaml                       依頼文と採点（隠しテスト・コミット・push しない・参考指標 verify が commit より前）
  fixtures/<repo>-<base7>/              上流の base の縮めた写し（.git なし）+ v0.1 の層の部品（E1b と同じ verify スキル 2 つ・checklist.json）
  checks/hidden_heldout.py              隠しテストの入口（eval/checks/hidden.py の grading_tmp() で一時ファイルを消す）
  checks/tasks/<id>.py                  タスクごとの CHECKS = [(名前, 関数, 罠か)]。HEAD を別プロセスで動かして振る舞いを見る
  reference/<id>/fixed/                 参照解（上流の fix を fixture に当てたもの + 依頼の残りの作業）。全ファイルにカナリア
  reference/<id>/naive/                 罠だけ: ありがちな浅い直し（依頼の残りの作業は正しく済ませたもの）
  reference/manifests/<fixture>.manifest.json   上流の URL・base・fix・残したパス・書き換えたファイル（changed）・足したファイル（added）
  tools/build_fixtures.py               manifest から fixture を作る（build）／作り直して一致と漏れを確かめる（check）
  tools/strip-layer.sh                  P0 の install で、層の部品（verify スキル・checklist）を外す
  selftest.sh                           決定的な自己確認（下）
```

- fixture の書き換えは 3 種類だけ（manifest の changed に記録）: 上流を指すバッジの削除、上流を指す URL を `example.invalid` にする、
  schedule のテストの `import mock` → `from unittest import mock`（隔離の中に mock パッケージがない）。縮める（trim）のは「残すパス」の指定で行う（docs の設定・CHANGELOG・CI の設定などを外す）。
- 上流の写しの置き場: `$HELDOUT_REPOS_DIR`（既定 /workspace/verify-layer-work/heldout-repos/{cachetools,schedule,more-itertools}）。ない端末では check は比較を SKIP し、漏れの走査だけ行う。
- 隠しテストは「依頼の機能（sub）」と「罠（trap）」の項目に分かれる。参照解は全項目に合格し、浅い直しは罠の項目だけ落ちる（selftest が確かめる）。
- ズル対策（feat/cheat-proof と互換）: checks/・reference/ は `eval/heldout/` の下（leak_check の名前の規則 `heldout/(checks|reference)` と bwrap で見えない）。
  隠しテスト・参照解の全ファイルにカナリア `VL-EVAL-CANARY-7f3c1a`。leak_check の上流の規則に cachetools・schedule・more-itertools と `pip install` を足した
  （新しい版や修正を取りに行く通信は INVALID）。`SANDBOX=dry ./run-eval.sh dry heldout` = 参照解を読みに行く模擬エージェントを隔離の中で動かすと 0/27（読めない）。
- P0 = 素のベースライン（V02-DESIGN 4 節）: run-eval.sh が、P0 のプロファイル（claude-baseline / codex-baseline）の install の先頭に `strip-layer.sh` を差し込んだ版を作る
  （同じディレクトリの `.p0.*.yaml`。.gitignore 済み）。P1・P2 の fixture には E1b と同じ v0.1 の部品が残る（チェックリストは dev の罠から作ったまま。held-out に合わせて足していない）。

## 3. 使い方

```bash
eval/heldout/selftest.sh                       # 決定的な自己確認（モデルを呼ばない・約 1.5 分）
python3 eval/heldout/tools/build_fixtures.py check
cd eval && ./run-eval.sh dry heldout           # 模擬 CLI で 9 タスク × 3 プロファイルを通す（参照解を当てるので全部合格）
SANDBOX=dry ./run-eval.sh dry heldout          # 隔離の通し確認（参照解が読めず全部不合格になるのが正しい）
./run-eval.sh smoke-p0 heldout                 # 本物: 罠 6 × P0 × 1（天井の確認。CLAUDE_CODE_OAUTH_TOKEN が要る）
AGENT=codex ./run-eval.sh smoke-p0 heldout     # Codex 側
TRIALS=3 ./run-eval.sh full heldout            # 決定的な評価（PREREG-v02.md: 9 × 3 × 3 = 81 試行／エージェント）
python3 tools/cheat_report.py <RUN_DIR>        # INVALID・改ざんを除いた集計
```
出力: `../../eval-out/<mode>-heldout`（Codex は `-heldout-codex`）。P2 を v0.2 にするには、v0.2 の入った checkout で実行する（プロファイルは E1b のもの）。

## 4. 自己確認の結果（2026-11-20、モデルの試行なし）

`selftest.sh`: すべて期待どおり（68 項目）。
- 9 タスクとも: fixture のままで見える側のテストが通り、隠しテストに落ちる。参照解を当てると見える側のテストが通り、隠しテストに合格する。
- 罠 6 件とも: 浅い直しは罠の項目だけ落ちる（sub はすべて合格）。浅い直しのときの見える側のテスト: grow-key だけ既存のテストでも落ちる。ほかの 5 件は通る。
- fixture 6 件: 上流の base の写し（build_fixtures.py check）。上流の URL・fix の SHA・カナリア・.git を含まない。51〜586 KB。P0 の手順で層の部品が消える。
- `./run-eval.sh dry heldout`: 27/27 合格（P0 の作業ツリーに層の部品 0、P1・P2 に 3）。`SANDBOX=dry`: 0/27。`./run-eval.sh dry e1b` は変更の前と同じ 30/30。`python3 eval/tools/test_cheatproof.py`: 18 件 OK。

## 続き（次のセッション）
1. **P0 のスモーク**（各罠 1 試行、Claude・Codex）: `./run-eval.sh smoke-p0 heldout`。罠ごとの合否を見て、P0 の罠の合格率が 20〜80% に入りそうかを確かめる。
   80% を超える罠があれば、本番の前に罠を固くする（依頼文の手がかりを減らす。隠しテストは変えない）。変えたら selftest を通し、この README の 4 節に、本番の前の変更として記録する。
2. P2 = v0.2 のプロファイルを用意する（feat/v0.2 の担当。held-out の中身は見せない。プロファイルの名前だけ合わせる）。
3. 本番: `TRIALS=3 ./run-eval.sh full heldout`（Claude）→ `AGENT=codex TRIALS=3 ./run-eval.sh full heldout`。判定は PREREG-v02.md のとおり。
