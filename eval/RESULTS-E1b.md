# E1b 結果（実リポジトリの罠）

## 事前に固定した判定基準（2026-11-19 16:05 JST、full の結果を見る前に書いた。結果を見たあとは書き換えない）

対象: tasks-e1b の罠 6 件 + E1 の対照 4 件。各セル 2 試行。採点は決定的な隠しチェックだけ（LLM 判定なし）。
Claude 側: P0 claude-baseline / P1 claude-static-rules / P2 claude-verify-layer（sonnet 5.5）。
Codex 側: P0 codex-baseline / P1 codex-agents-md / P2 codex-verify-layer（gpt-6.2-sol）。各エージェントで別々に判定する。

| 判定 | 条件 |
|---|---|
| **有用** | P2 の罠の合格数 > P0 の罠の合格数、かつ罠でタスク×試行の対で 改善 > 後退、かつ対照で後退 0 |
| **有用でない** | 上を満たさない。ただし判定不能に当たるときは判定不能 |
| **判定不能** | (a) P0 の罠の合格率が 20〜80% の外（12 試行で 10 以上 = 天井、2 以下 = 床）、(b) P2 の罠でチェックリストが一度も発火しない、(c) 有効な試行（agent_error・利用上限を除く）が 75% 未満 |

- 参考（事前情報）: full の前の P0 スモークは Claude 9/12（2 回）、Codex 4/6（1 回）。
- 補助: agent-harness-eval の新しい既定（sound-eval-defaults、差分の信頼区間つき verdict）が使えるようになったら、同じ trials.jsonl を再判定して併記する。主判定は上の表。
- 配備: Claude 側・Codex 側それぞれ「有用」のときだけ、その部分を配備する。

## Claude 側の結果（2026-11-19 19:3x JST、上の規則で判定）

- 実行: full 20261119-160340-949-bf（16:03、利用上限で 24 試行が無効）＋ 無効セルの再実行 20261119-191741-509-d2（19:17、trial 1 として結合）。結合: eval-out/hard/full-e1b-merged/trials.jsonl。有効 60/60（100%）。sonnet 5.5、隠しチェックのみ。費用見積もり計 $8.23（API 換算）。
- 罠の合格: P0 9/12（75%、20〜80% の範囲内 → 天井・床ではない）、P1 10/12、P2 9/12。対照: 全プロファイル 8/8。
- P2 vs P0（罠の対）: 改善 1（reviewer-identity #0）/ 後退 1（reviewer-identity #1）。対照の後退 0。P1 vs P0: 改善 1 / 後退 0。
- チェックリスト発火: P2 の罠 12 試行中 4 試行で verify スキル呼び出しあり（(b) に当たらない）。
- 全プロファイルが落とした罠: trap-stop-hook-decode（0/6）。
- **判定: 有用でない**（P2 の罠 9 = P0 の罠 9 で「>」を満たさない、改善 1 = 後退 1）。規則により Claude 側は配備しない。

## Codex 側の予備結果（2026-11-19 21:04 JST、各セル 1 試行。判定ではない＝n が小さすぎる）

- 実行: eval-out/eval-out/hard/full-e1b-codex/20261119-210444-946-9d（`TRIALS=1`）。gpt-6.2-sol、隠しチェックのみ。有効 30/30。
- 罠の合格: P0 codex-baseline 4/6、P1 codex-agents-md 5/6、P2 codex-verify-layer 5/6。対照: 全プロファイル 4/4。
- P2 vs P0（罠の対）: 改善 1（reviewer-identity）/ 後退 0。P1 vs P0 も同じ（改善 1 / 後退 0）。
- 全プロファイルが落とした罠: trap-stop-hook-decode（Claude 側と同じ）。
- トークン（30 試行計）: 入力 6.90M（うちキャッシュ読み 6.21M）、出力 0.069M。API 換算 約 $2.70（本体のみ、判定役 $0）。
- 注意: verify スキル（.agents/skills/verify）は fixture に入っているため、P0 でも読める（実際に P0 の罠試行でも SKILL.md を読んでいる）。P2 との差は hook と AGENTS.md の 2 行だけ。v0.2 の評価ではベースラインからスキルを外す。
- ズル対策の再検査（feat/cheat-proof の leak_check・tamper_check、23:1x）: trap-wait-superseded / codex-baseline が `rg --files -g AGENTS.md /workspace` で試行の外を探索 → INVALID（答えは読んでいない）。改ざん 0。これを除くと P0 罠 3/5（有効 5）、P1 5/6、P2 5/6。外部ネットワーク（SDK の資料の web_search・curl）は 10 試行で警告。Claude 側 60 試行は INVALID 0・改ざん 0（判定は変わらない）。
- 事前規則の n（各セル 2 試行）に届いていないので、判定は出さない。v0.2 の決定的な評価は held-out の罠で行う（docs/V02-DESIGN.md、eval/heldout/PREREG-v02.md）。
