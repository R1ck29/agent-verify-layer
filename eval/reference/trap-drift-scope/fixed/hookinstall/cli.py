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
