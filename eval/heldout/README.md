# held-out の罠（Verify v0.2 の決定的な評価用）— 作り方と候補（2026-11-19 23:1x JST）

- 目的: v0.2 の「有用か」を、設計に使っていない罠で決める。旧 6 罠（tasks-e1b）は dev 専用。
- **v0.2 の設計・実装の担当（feat/v0.2）には、このディレクトリを見せない**。作る担当は v0.2 の実装と別のセッション。
- 状態: **未作成（候補と作り方だけ）**。11/19 22:54 に Codex の box の認証が切れ（refresh token の失効）、Claude は 5h 枠 100% のため、作成は次の枠で行う。

## 候補（実在の修正。6 件以上を選ぶ。分類を散らす）
| # | 出典（base = 修正の親、fix = 修正） | 分類 | 罠の芯（依頼文には書かない） |
|---|---|---|---|
| H1 | R1ck29/agent-harness-eval 87641fa | 文字・符号化 | UTF-8 でないハーネスのファイルを書き換えずに残す |
| H2 | R1ck29/agent-harness-eval c809230 | 環境・状態の漏れ | 親セッションの変数を試行に渡さない |
| H3 | R1ck29/agent-harness-eval e88ac12 | パスの祖先 | 祖先のディレクトリにある .claude/.codex/.agents も漏れとして扱う |
| H4 | R1ck29/agent-harness-eval 37f2e60 | データの漏れ | 却下した提案の本文を出力に残さない |
| H5 | R1ck29/agent-harness-eval ce32a85 / c512661 | 入力の検証・境界 | 壊れた --previous / --min-tasks の境界を、何かする前に拒む |
| H6 | 公開 OSS（小さな Python/JS ライブラリ）の、境界・順序・冪等性の修正 2〜3 件 | 境界・順序・API の契約 | 作る担当が選ぶ（ライセンス表記を残し、manifest に URL・base・fix を書く） |
| H7 | harness-sync-check の backup_tree（ディレクトリへのシンボリックリンクで IsADirectoryError、11/19 修正） | ファイルシステムの形 | シンボリックリンクのディレクトリを壊さずに退避する |
対照 3 件以上: 素直な小さい変更（v0.2 が邪魔しないことを見る）。

## 作り方（tasks-e1b と同じ形）
- eval/heldout/{tasks,fixtures,checks,reference}/。fixture = base の縮めたスナップショット（.git なし、上流の URL・fix の SHA を本文に入れない）。manifest・参照解・隠しテストは fixture の外。
- 依頼文は実務の形（複数の小さな作業。そのうち 1 つに罠）。隠しテストは振る舞いを決定的に見る（ファイルの文字列を見ない）。参照解（fixed/）と隠しテストにカナリア `VL-EVAL-CANARY-7f3c1a` を入れる（leak_check が検出）。
- 自己確認 `selftest.sh`（モデルを呼ばない）: 参照解は通る・素の fixture は落ちる・ありがちな浅い直し（naive patch）は落ちる。
- 難しさ: 素のベースラインで 30〜70% を狙う（天井を避ける）。P0 のスモーク（各 1 試行）で確かめ、80% 超なら罠を固くしてから本番。
- run-eval.sh に suite `heldout` を足す（profiles は E1b のものを使い、P0 は verify スキル・checklist なしの fixture）。全試行を bwrap の中で（feat/cheat-proof）。
