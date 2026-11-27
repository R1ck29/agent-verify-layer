"""taskstore: タスクの一覧を JSON ファイルに保存する小さなライブラリ。"""


class StoreError(Exception):
    """保存・読み込みに失敗した。"""
