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
