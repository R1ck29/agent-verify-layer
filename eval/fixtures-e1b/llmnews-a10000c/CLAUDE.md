# llm_news

LLM 関連ニュース（公式ブログ・arXiv・X）を集めて Markdown 日報にする小さなツール。Ports & Adapters 構成。

- `src/llm_news/domain/` — データクラスとポート（Protocol）
- `src/llm_news/adapters/llm/` — タグ付け・要約のアダプタ（ProCode は claude-agent-sdk 経由）
- `src/llm_news/adapters/renderer/` — Markdown 日報の出力

テスト: リポジトリのルートで `python3 -m unittest discover -s tests`（標準ライブラリだけで動く）。
