"""Execute a selected Python runner from outside its isolated repository copy."""

import json
from pathlib import Path
import sys


def main() -> None:
    manifest, output = map(Path, sys.argv[1:])
    request = json.loads(manifest.read_text(encoding="utf-8"))
    action = request["action"]
    try:
        # -I excludes the script directory and the repository from startup imports.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from python_evidence import CaseEvidence, copy_path
        import importlib

        name = {"pytest": "pytest_plugin", "unittest": "unittest_runner"}[request["runner"]]
        runner = importlib.import_module(name)
        root = Path.cwd()
        config = request["config"]
        roots = [root]
        for value in config.get("srcRoots", ["src"]):
            source_root = copy_path(root, value)
            if source_root.is_dir() and source_root not in roots:
                roots.append(source_root)
        sys.path[:0] = list(map(str, roots))
        if action == "case":
            evidence = CaseEvidence(root, request["caseData"], request["runner"])
            result = runner.run_case(evidence, config)
        else:
            result = runner.run_suite(root, config, request.get("tests"), action == "collect")
    except Exception as error:
        reason = str(error) if error.__class__.__name__ == "UnsupportedEvidence" else type(error).__name__
        result = {"status": "error", "reason": reason} if action == "case" else {
            "ok": False, "tests": [], "reason": reason
        }
    output.write_text(json.dumps(result, ensure_ascii=True, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    main()
