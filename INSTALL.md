# v0.2 の導入

利用するホストを選び、導入先で [README の v0.2 の使い方](README.md#v02-の使い方) に沿って hook と `verify2` スキルを登録します。`--check` は変更予定を表示し、`--apply` は登録、`--uninstall` は削除を行います。リポジトリの `.verify-layer.json` で `observe` または `enforce` を選びます。

`node scripts/vl.js doctor --repo <対象リポジトリ>` で hook の配線とランナー実行環境を確認します。実セッションの確認項目は [スモーク手順](docs/SMOKE.md#v02-の開始と-stop-の確認) にあります。

v0.1 観察モードの導入手順は [INSTALL_FOR_CLAUDE.md](INSTALL_FOR_CLAUDE.md) にあります。
