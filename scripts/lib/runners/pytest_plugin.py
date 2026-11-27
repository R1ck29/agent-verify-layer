"""Run pytest with copy-local collection and assertion evidence from an external plugin."""

import os
from pathlib import Path
import sys

import pytest

from python_evidence import copy_path, require


def arguments(root: Path, config: dict) -> list[str]:
    config_path = copy_path(root, config["pytestConfig"]) if config.get("pytestConfig") else Path(os.devnull)
    return [f"--rootdir={root}", "-c", str(config_path), f"--confcutdir={root}",
            "-p", "no:cacheprovider", "-o", "enable_assertion_pass_hook=true"]


def test_info(item, root: Path) -> dict:
    path = Path(item.path).resolve()
    require(path.is_relative_to(root), "Pytest collected a file outside the copy")
    owner = getattr(item, "cls", None)
    return {
        "id": item.nodeid,
        "file": path.relative_to(root).as_posix(),
        "className": owner.__name__ if owner else None,
        "name": getattr(item, "originalname", None) or item.name,
    }


class SuitePlugin:
    def __init__(self, root: Path, tests: list[dict] | None):
        self.root = root
        self.wanted = None if tests is None else [item["id"] for item in tests]
        self.tests = []
        self.outcomes = {}
        self.error = None

    @pytest.hookimpl(trylast=True)
    def pytest_collection_modifyitems(self, config, items):
        if len({item.nodeid for item in items}) != len(items):
            self.error = "Pytest collected duplicate test IDs"
            return
        if self.wanted is not None:
            observed = {item.nodeid: item for item in items}
            missing = set(self.wanted) - observed.keys()
            if missing:
                self.error = "Missing pytest IDs: " + ", ".join(sorted(missing))
                items[:] = []
                return
            skipped = [item for item in items if item.nodeid not in self.wanted]
            if skipped:
                config.hook.pytest_deselected(items=skipped)
            items[:] = [observed[name] for name in self.wanted]
        self.tests = [test_info(item, self.root) for item in items]

    def pytest_collectreport(self, report):
        if report.failed:
            self.error = "Pytest collection failed"

    def pytest_runtest_logreport(self, report):
        if report.failed:
            self.outcomes[report.nodeid] = "fail"
        elif report.skipped:
            self.outcomes.setdefault(report.nodeid, "skip")
        elif report.when == "call":
            self.outcomes.setdefault(report.nodeid, "pass")


def run_suite(root: Path, config: dict, tests: list[dict] | None, collect: bool) -> dict:
    paths = config.get("existingTestFiles", [])
    if tests is not None:
        paths = list(dict.fromkeys(item["file"] for item in tests))
        if not paths:
            return {"ok": True, "tests": []}
    argv = arguments(root, config)
    if collect:
        argv.append("--collect-only")
    argv += [str(copy_path(root, file)) for file in paths]
    plugin = SuitePlugin(root, tests)
    exit_code = pytest.main(argv, plugins=[plugin])
    valid_exit_codes = (0, 5) if collect else (0, 1, 5)
    if plugin.error or exit_code not in valid_exit_codes:
        return {"ok": False, "tests": [], "reason": plugin.error or f"Pytest exited with {exit_code}"}
    if not collect:
        for record in plugin.tests:
            outcome = plugin.outcomes.get(record["id"])
            if outcome is None:
                return {"ok": False, "tests": [], "reason": "Pytest outcome missing"}
            record["status"] = outcome
    return {"ok": True, "tests": plugin.tests}


class RaisesWrapper:
    def __init__(self, context, evidence):
        self.context = context
        self.evidence = evidence

    def __enter__(self):
        return self.context.__enter__()

    def __exit__(self, exc_type, exc, tb):
        evidence = self.evidence
        origin = evidence.origin(tb)
        evidence.exception_origin = origin
        if exc_type is not None and not origin:
            evidence.error = "Exception did not originate in the entry"
        try:
            result = self.context.__exit__(exc_type, exc, tb)
        except BaseException:
            if exc_type is None:
                evidence.assertions.append("mismatch")
            raise
        evidence.assertions.append("pass" if result else "mismatch")
        return result


class CasePlugin:
    def __init__(self, evidence):
        self.evidence = evidence
        self.reports = {}
        self.absence = None
        self.selected = None
        self.collection_failed = False

    @pytest.hookimpl(trylast=True)
    def pytest_collection_modifyitems(self, items):
        if len(items) != 1:
            self.evidence.error = "Pytest must collect exactly one designated test"
            items[:] = []
            return
        item = items[0]
        self.selected = item.nodeid
        class_name = getattr(item, "cls", None)
        actual = class_name.__name__ if class_name else None
        test_id = self.evidence.case["testId"]
        allowed = {item.nodeid, item.name}
        if actual:
            allowed.add(actual + "." + item.name)
            allowed.add(actual + "::" + item.name)
        if str(Path(item.path).resolve()) != self.evidence.file or item.name != self.evidence.static.method                 or actual != self.evidence.static.class_name or test_id not in allowed:
            self.evidence.error = "Pytest collected a different test"
            items[:] = []

    def pytest_exception_interact(self, node, call, report):
        error = call.excinfo.value
        if isinstance(error, pytest.Collector.CollectError) and isinstance(error.__cause__, ImportError):
            error = error.__cause__
        tb = error.__traceback__
        self.absence = self.evidence.classify_absence(error, tb) or self.absence

    def pytest_collectreport(self, report):
        if report.failed:
            self.collection_failed = True

    @pytest.hookimpl(wrapper=True)
    def pytest_runtest_call(self, item):
        with self.evidence.profiler():
            return (yield)

    def pytest_assertion_pass(self, item, lineno, orig, expl):
        assertion = self.evidence.static.assertion
        if item.nodeid == self.selected and assertion.lineno <= lineno <= assertion.end_lineno:
            self.evidence.assertions.append("pass")

    @pytest.hookimpl(wrapper=True)
    def pytest_runtest_makereport(self, item, call):
        report = yield
        self.reports[call.when] = report
        if call.when == "call" and call.excinfo:
            exc = call.excinfo.value
            tb = exc.__traceback__
            if self.evidence.origin(tb):
                self.evidence.exception_origin = True
                if not self.evidence.assertions:
                    self.evidence.assertions.append("mismatch")
            elif type(exc) is AssertionError and not self.evidence.assertions                     and self.evidence.at_test_assertion(tb):
                self.evidence.assertions.append("mismatch")
        return report


def run_case(evidence, config: dict) -> dict:
    plugin = CasePlugin(evidence)
    evidence.exception_origin = False
    previous = pytest.raises

    def raises(*args, **kwargs):
        context = previous(*args, **kwargs)
        if evidence.case_frame(sys._getframe(1)) is not None:
            return RaisesWrapper(context, evidence)
        return context

    argv = arguments(Path(evidence.root), config) + ["--import-mode=importlib", evidence.file]
    pytest.raises = raises
    evidence.install_path_monitor()
    evidence.monitoring = True
    try:
        exit_code = pytest.main(argv, plugins=[plugin])
    finally:
        evidence.monitoring = False
        pytest.raises = previous

    if plugin.absence:
        if evidence.error == "Pytest must collect exactly one designated test" and plugin.collection_failed:
            evidence.error = None
        return evidence.result("absent", absence=plugin.absence)
    reports = plugin.reports
    if exit_code in (0, 1) and len(reports) == 3 and reports["setup"].passed and reports["teardown"].passed:
        call = reports["call"]
        if not hasattr(call, "wasxfail"):
            if call.passed and evidence.assertions == ["pass"]:
                return evidence.result("pass", exception_origin=evidence.exception_origin)
            if call.failed and evidence.assertions == ["mismatch"]:
                return evidence.result("mismatch", exception_origin=evidence.exception_origin)
    return evidence.result("error", reason="Pytest did not complete the designated assertion")
