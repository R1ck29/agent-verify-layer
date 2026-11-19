# Verify v0.2 設計（2026-11-19 23:1x JST、たたき台）

位置づけ: Riku 11/19 22:49「Verify については改善して有用になるよう工夫して。評価の答え見てしまったりしてズルしないように」。
v0.1 は E1b（実リポジトリの罠 6 + 対照 4）で **有用でない**（Claude: P0 9/12・P1 10/12・P2 9/12）。この文書は、その失敗の分析と、v0.2 の設計・実装計画・評価計画。
作成: コーディネーター（Codex の box の認証が切れ、Claude は 5h 枠が 100% のため、トランスクリプトの決定的な集計から起こした）。**実装の前に、別系統のモデル（Claude Opus か Codex sol）がこの文書をレビューすること**（下の「レビューで確かめること」）。
held-out の罠（eval/heldout）は、この設計の担当には見せない（この文書は dev の 6 罠のトランスクリプトだけから書いた）。

## 1. 失敗の分析（証拠: eval-out/hard/full-e1b-merged の 60 試行、Codex 21:04 の 30 試行）

| 観察 | 数値 | 意味 |
|---|---|---|
| Claude P2 で verify スキルが呼ばれた罠の試行 | 4/12 | スキルの呼び出しはモデル任せ。PostToolUse の commit hook は **コミットの後** に動き、観察モードでは記録するだけ → 結果を変えられない |
| Codex P2 で `mark verify` が走った罠の試行 | 6/6 | **確実に発火しても** P1（AGENTS.md のみ）と同じ 5/6。発火の確実さだけでは効かない |
| verify スキル・チェックリストが fixture にあり、**P0 でも読まれた** | Claude P0 の罠 12 試行のうち大半で `cat .claude/skills/verify/SKILL.md`、一部で Skill(verify) | 比較の汚染: P0 は「層なし」ではなかった。P2−P0 の差は hook と規則 2 行だけ |
| fixture の verify スキルの中身 | 「`python3 -m unittest discover -s tests` を実行して OK なら PASS」 | **既存のテストを回すだけ**。罠は「新しく頼まれた振る舞いの、仕様の端」にあり、既存のテストは定義上それを含まない → verify が通っても何も保証しない |
| 落ちた罠の中身（隠しテストの理由） | stop-hook-decode 6/6 落ち: ASCII の locale で非 ASCII のパスを含む JSON → UnicodeEncodeError。reviewer-identity: 大文字小文字・空白の違う同一人物がレビューを通せた | どちらも「依頼の文言から導ける、入力の別の形（表記ゆれ・符号化・環境）」を試していない。落ちた試行もテストは 1〜3 回走らせている（＝テストを回す量ではなく、何を試すかの問題） |
| 費用 | Claude 60 試行 $8.23、Codex 30 試行 約 $2.70 | v0.2 の追加分は 1 試行あたり +20〜40% までに抑える |

**根本原因**: v0.1 の verify は「既存の確認を回して記録する」もので、(1) 新しい振る舞いを確かめる手順を持たない、(2) 呼ばれるかがモデル任せで、呼ばれても遅い（コミットの後）、(3) 評価ではベースラインにも同じスキルがあった。

## 2. v0.2 の設計（一般の手順。dev の罠の個別の不具合は書かない）

### 2.1 発火: 「終わろうとしたとき」に 1 回だけ確実に（Stop hook）
- Claude Code・Codex とも `Stop` hook がある（Codex: `decision: "block"` + `reason` で、reason を新しいプロンプトとして作業を続けさせる。Claude: 同じく block で続行）。
- `vl.js hook stop`: その回のターンで **作業ツリーに変更（コミット済みを含む、seed/セッション開始時の HEAD からの差分）があり**、かつ **今の木（tree hash）に対する v0.2 の検証記録がない** ときだけ、block して「検証の手順」（2.2）を短く渡す。`stop_hook_active` が真なら二度目は止めない（無限ループ防止）。ドキュメントだけの差分は対象外。
- 記録があれば何もしない。1 つの木に 1 回だけ。観察モードは block せず、台帳に「検証なしで終わった」を書くだけ。
- コミットの直前（PreToolUse の `git commit`）では止めない（v0.1 の commit hook は記録用に残す）。止める場所を 1 つにして、割り込みの回数とトークンを抑える。

### 2.2 検証の手順（verify v0.2 スキル / Stop の reason の本文）: 「依頼 → 証拠」の対応表
1. **依頼を要件に分ける**: 依頼の文（番号つきの項目・「〜のとき〜する」）を、確かめられる要件の一覧にする（R1, R2, …）。
2. **要件ごとに、実際の入口を動かすテストを書く**: 関数の単体だけでなく、利用者が呼ぶ入口（CLI・hook・公開 API）を、本物の呼ばれ方（標準入力・環境変数・ファイル）で動かす。テストは tests/ に残す（使い捨てにしない）。
3. **要件ごとに、入力の別の形を 2 つ以上試す**（一般の分類から選ぶ。どれを選んだか書く）:
   境界（空・1 個・上限ちょうど/超え）／形の違い（型・配列とオブジェクト・欠けたキー）／文字（非 ASCII・符号化・locale・改行・BOM）／表記ゆれ（大文字小文字・前後の空白・Unicode 正規化）／順序と繰り返し（2 回目・並び替え・同時）／失敗の経路（例外・終了コード・stderr）／本物のデータの形（SDK・上流が実際に返す形を、手元の資料から）。
4. **前後で比べる（偽の安心を防ぐ）**: 足したテストのうち、振る舞いを変える要件のテストは、**変更前の木では落ち、変更後では通る** ことを確かめる。`vl.js verify-diff` が決定的に行う: HEAD とセッション開始時の木を一時ディレクトリに取り出し、新しいテストだけを両方で実行し、結果を台帳に書く（モデルは呼ばない）。「前でも通る」テストしかない要件は「確かめていない」と表示する。
5. **全体の確認**: リポジトリの既存の確認（v0.1 の手順）を回す。
6. **記録**: `vl.js mark verify --v2 --map map.json`（要件 → テスト名 → 前/後の結果）。記録は今の木の hash に結びつく。記録の後に変えたら 2.1 がもう一度止める。

### 2.3 敵対的な見直し（任意の段。運用では高リスクの変更だけ）
- 要件ごとの対応表と差分だけを、**新しい文脈**（Claude はサブエージェント、Codex は `codex exec` の別セッション）に渡し、「この実装を壊す入力を 1 つ探し、落ちるテストとして書け」と 1 回だけ頼む。見つかったら直してから 2.2 の 4〜6 をやり直す。
- 既存の sample-harness の `independent-verification`（グラフの節の受け入れを、新しい文脈で PASS/FAIL/UNCERTAIN にする）とは役割が違う: あちらは「節の完了の判定」、こちらは「コミット前に反例を 1 つ探す」。sample-harness が入っているリポジトリでは、この段を省き、independent-verification の証拠に v0.2 の対応表を渡す（重複させない）。
- 既定は off（`VL_ADVERSARIAL=on` かリポジトリの設定で on）。費用の上限: 1 回・出力 2k トークン程度。

### 2.4 既存のハーネスとの重なりを避ける
| 既存 | 役割 | v0.2 の扱い |
|---|---|---|
| sample-harness（samplectl・Stop hook samplectl-claude-stop・independent-verification・review-changes） | タスクグラフの進行・完了チェック・独立検証 | Stop hook は並べて動く（どちらも block できる。v0.2 は stop_hook_active を見て二度止めない）。2.3 は sample-harness があれば委ねる |
| wikiskill / llm-wiki | 知識の蓄積 | 重ならない |
| yomiyasu・ponytail（lean-agent-skill）・typesafe-ai | 読みやすさ・スキルの書き方・型 | 重ならない。v0.2 のスキル文は ponytail の作法で短くする |
| CLAUDE.md / AGENTS.md の規則 | 静的な指示（P1） | v0.2 は規則の行を増やさない（Stop の reason で、必要なときだけ渡す） |
| v0.1 の commit hook・台帳・doctor | 記録 | そのまま使う。v0.2 は台帳に `kind: verify2` の行を足す |

### 2.5 導入（柔軟さ）
- リポジトリ単位の opt-in（`.verify-layer.json` で on/off・観察/強制・敵対段の有無・対象外のパス）。全社の既定は観察モード。
- Claude・Codex 両対応（Stop の入出力の差は vl.js で吸収）。ネットワーク不要・秘密を扱わない。API 課金の環境向けに、追加の費用の上限（1 セッションで block は木ごとに 1 回・敵対段は 1 回）と、台帳に追加のトークン（分かる範囲）を書く。
- 失敗の仕方: hook の例外・時間切れは「止めない」（onFailure continue）。誤って止めた場合も 1 回で終わる。

### 2.6 ズル（記録だけ作る）への対策
- 記録は `vl.js` が自分で前後の木でテストを回した結果だけを使う（モデルが書いた「通った」は使わない）。
- テストの削除・skip・設定で対象を狭める変更は、記録を無効にし表示する（eval の tamper_check と同じ規則を vl.js に）。
- 評価側: 隠しテストで決める・leak_check・tamper_check・bwrap（feat/cheat-proof）。

## 3. 実装計画（次の段。新しいファイルを優先）
- 新規: `scripts/lib/stop.js`（Stop の入力の読み取り・判定・block の出力。Claude/Codex 両方）、`scripts/lib/verify-diff.js`（前後の木の取り出しと新しいテストの実行。python unittest/pytest・node --test・npm test を検出）、`scripts/lib/tamper.js`、`skills/verify2/SKILL.md`（skill-creator で作り、agent-harness-eval で評価してから配備）、`hooks/hooks.v02.json`（Stop）、`codex/hooks.v02.json`。
- 既存への最小の変更: `scripts/vl.js` にサブコマンド `hook stop`・`verify-diff`・`mark verify --v2` を足すだけ（分岐の追加）。
- **XFIX の後に統合**（PROMPT-XFIX が feat/v0.1 で scripts/install.js・doctor・台帳・README/INSTALL を直すため、今は触らない）: install.js に `--v2`（Stop hook と verify2 スキルを入れる）、doctor に Stop hook の確認、README/INSTALL の節。
- テスト: Stop の判定（変更なし・ドキュメントだけ・記録あり・stop_hook_active・観察/強制）、verify-diff（前で落ち後で通る/前でも通る/テストなし/テストの削除）、Codex と Claude の入出力の形、Windows のパス。
- dev スモーク（旧 6 罠、Codex sol、各 1 試行、P0 = スキルなしの素のベースライン・P2 = v0.2）: 推定 12 試行 × 約 $0.09〜0.12 = 約 $1.5（Codex 21:04 の実測 $2.70/30 試行 から）。Claude sonnet で同じなら 12 × 約 $0.14 = 約 $1.7。

## 4. 評価計画（決定的な評価は held-out の罠だけ）
- プロファイル: **P0 = 素のベースライン**（fixture から verify スキル・checklist を外す）、P1 = v0.1 の層（今のもの）、P2 = v0.2。Claude（sonnet 5.5）と Codex（gpt-6.2-sol）で別々に判定。
- 規則は実行の前に `eval/heldout/PREREG-v02.md` に固定（P0 の罠の合格率 20〜80% の外は判定不能、有用 = P2 > P0 かつ 改善 > 後退 かつ 対照の後退 0 かつ 有効 75% 以上、leak は無効、改ざんは不合格、各セル 3 試行、AHE sound-eval の差の信頼区間を副判定）。
- 全試行を bwrap の中で動かし、leak_check・tamper_check を通す（feat/cheat-proof）。

## 5. レビューで確かめること（実装の前）
1. 2.2 の 3（入力の別の形）が、dev の 6 罠に合わせ込んだものになっていないか（一般の分類として妥当か）。
2. Stop で 1 回止める費用（追加ターン）が、API 課金で許容できるか。
3. verify-diff の「前の木」で新しいテストを回すとき、import の失敗（新しい関数がない）を「前で落ちた」と数えてよいか（よい: 振る舞いがなかった）。
4. sample-harness の Stop hook と並べたときの順序・二重 block。
