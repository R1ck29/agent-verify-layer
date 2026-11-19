# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""コマンドライン: python3 -m hookinstall.cli install|uninstall --settings PATH"""
import argparse

from . import installer


def main(argv=None):
    parser = argparse.ArgumentParser(prog="hookinstall")
    parser.add_argument("action", choices=["install", "uninstall", "check"])
    parser.add_argument("--settings", required=True)
    args = parser.parse_args(argv)
    if args.action == "check":
        return 0 if installer.check(args.settings) else 1
    getattr(installer, args.action)(args.settings)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
