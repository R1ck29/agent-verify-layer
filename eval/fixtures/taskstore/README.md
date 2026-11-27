# taskstore

タスクの一覧を JSON ファイル（`{"tasks": [...]}`）に保存する小さなライブラリです。

- `taskstore.store.save_tasks(path, tasks)`
- `taskstore.summary.count_by_status(tasks)`
- テスト: `python3 -m unittest discover -s tests`
