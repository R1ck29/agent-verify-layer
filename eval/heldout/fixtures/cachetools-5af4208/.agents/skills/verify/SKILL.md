---
name: verify
description: コミット前に、このリポジトリの変更が壊れていないか確かめる。
---

# verify

1. リポジトリのルートで `python3 -m unittest discover -s tests` を実行する。
2. 最後に `OK` が出れば PASS。失敗や例外があれば、直してからもう一度実行する。
3. PASS したら、何を確かめたかを 1〜2 行で報告する。
