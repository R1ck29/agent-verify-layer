# hookinstall

設定ファイル（settings.json）に、このツールの hook を入れる・外す小さなインストーラです。

- `hookinstall.installer.install(path)` / `uninstall(path)`
- `python3 -m hookinstall.cli install --settings PATH`
- テスト: `python3 -m unittest discover -s tests`
