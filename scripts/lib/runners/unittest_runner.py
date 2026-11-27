"""Execute unittest discovery or a specific synthetic evidence test."""

from contextlib import ExitStack
import importlib.util
import inspect
from pathlib import Path
import sys
import unittest
from unittest import mock

from python_evidence import copy_path, require


class Collector(unittest.TestLoader):
    """Mark modules actually considered by discover, not ordinary imports."""

    def __init__(self, root: Path, allowed: set[str] | None):
        super().__init__()
        self.root = Path(root).resolve()
        self.allowed = allowed
        self.visited = set()
        self.discovery_target = None

    def _find_test_path(self, full_path: str, pattern: str, *args, **kwargs):
        # Python 3.14+ passes namespace as a third argument; 3.13 and earlier do not.
        path = Path(full_path).resolve()
        if not path.is_relative_to(self.root):
            self.errors.append("Unittest discovery path escapes the copy")
            return None, False
        relative = path.relative_to(self.root).as_posix()
        if self.allowed is not None:
            if path.is_file() and relative not in self.allowed:
                return None, False
            if path.is_dir() and not any(item.startswith(relative + "/") for item in self.allowed):
                return None, False
        original = self.discovery_target
        self.discovery_target = (path / "__init__.py").resolve() if path.is_dir() else path
        try:
            return super()._find_test_path(full_path, pattern, *args, **kwargs)
        finally:
            self.discovery_target = original

    def loadTestsFromModule(self, module, *, pattern=None):
        pathname = vars(module).get("__file__")
        if pathname and self.discovery_target is not None:
            path = Path(pathname).resolve()
            if path == self.discovery_target and path.is_relative_to(self.root):
                self.visited.add(path.relative_to(self.root).as_posix())
        return super().loadTestsFromModule(module, pattern=pattern)


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def test_info(test: unittest.TestCase, root: Path) -> dict:
    target = getattr(test, "_testFunc", type(test))
    root = Path(root).resolve()
    try:
        source = inspect.getsourcefile(target)
        if source:
            source = Path(source).resolve()
            source = source.relative_to(root).as_posix() if source.is_relative_to(root) else None
    except (OSError, TypeError):
        source = None
    return {"id": test.id(), "file": source, "className": type(test).__name__,
            "name": getattr(test, "_testMethodName", None)}


class Result(unittest.TestResult):
    def __init__(self, evidence=None):
        super().__init__()
        self.status = {}
        self.errors_seen = []
        self.evidence = evidence

    def addSuccess(self, test):
        super().addSuccess(test)
        self.status[test.id()] = "pass"

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.status[test.id()] = "skip"

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self.status[test.id()] = "skip"

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.status[test.id()] = "fail"

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.status[test.id()] = "fail"
        self.errors_seen.append(err)

    def addError(self, test, err):
        super().addError(test, err)
        self.status[test.id()] = "fail"
        self.errors_seen.append(err)

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            self.status[test.id()] = "fail"
            if self.evidence is not None:
                self.evidence.error = "Unittest subtest failed"


def run_suite(root: Path, config: dict, tests: list[dict] | None, collect: bool) -> dict:
    start = copy_path(root, config.get("unittestStartDir", "."))
    top = copy_path(root, config.get("unittestTopLevelDir", "."))
    load_tests = set(config.get("loadTests", []))
    allowed = None
    if tests is not None:
        allowed = {item["file"] for item in tests if item.get("file")} | load_tests
    visited = set()
    observed = {}
    for pattern in config.get("unittestPattern", ["test*.py"]):
        loader = Collector(root, allowed)
        discovered = list(flatten(loader.discover(str(start), pattern=pattern, top_level_dir=str(top))))
        visited.update(loader.visited)
        if loader.errors or any(isinstance(item, unittest.loader._FailedTest) for item in discovered):
            return {"ok": False, "tests": [], "visited": sorted(visited), "reason": "Unittest discovery failed"}
        for item in discovered:
            observed.setdefault(item.id(), item)
    missing = sorted(load_tests - visited)
    if missing:
        return {"ok": False, "tests": [], "visited": sorted(visited),
                "reason": "Unvisited load_tests files: " + ", ".join(missing)}
    ordered = sorted(observed) if tests is None else [item["id"] for item in tests]
    missing_tests = sorted(set(ordered) - observed.keys())
    if missing_tests:
        return {"ok": False, "tests": [], "visited": sorted(visited),
                "reason": "Missing unittest IDs: " + ", ".join(missing_tests)}
    result = Result()
    if not collect:
        unittest.TestSuite(observed[key] for key in ordered).run(result)
    items = [test_info(observed[key], root) for key in ordered]
    if not collect:
        for record in items:
            if record["id"] not in result.status:
                return {"ok": False, "tests": [], "visited": sorted(visited), "reason": "Unittest outcome missing"}
            record["status"] = result.status[record["id"]]
    return {"ok": True, "tests": items, "visited": sorted(visited)}


def enter_assertion_hooks(stack: ExitStack, evidence) -> None:
    case_class = unittest.TestCase
    standard_comparators = dict(case_class()._type_equality_funcs)
    original_get = case_class._getAssertEqualityFunc
    original_base = case_class._baseAssertEqual
    standard_methods = {name: getattr(case_class, name) for name in standard_comparators.values()}

    def observe(name, original):
        def wrapper(instance, *args, **kwargs):
            if evidence.case_frame(sys._getframe(1)) is None:
                return original(instance, *args, **kwargs)
            if name == "assertRaises":
                if getattr(instance.assertRaises, "__func__", None) is not wrapper:
                    evidence.error = "Unittest exception assertion was replaced"
                return original(instance, *args, **kwargs)
            if getattr(getattr(instance, name), "__func__", None) is not wrapper:
                evidence.error = "Unittest assertion was replaced"
            if name == "assertEqual":
                if getattr(instance._getAssertEqualityFunc, "__func__", None) is not original_get:
                    evidence.error = "Unittest comparator dispatcher was replaced"
                else:
                    actual, expected = args[:2]
                    bound = original_get(instance, actual, expected)
                    selected = standard_comparators.get(type(actual)) if type(actual) is type(expected) else None
                    standard = standard_methods[selected] if selected else original_base
                    if getattr(bound, "__func__", None) is not standard or getattr(bound, "__self__", None) is not instance:
                        evidence.error = "Unittest type comparator was replaced"
            try:
                result = original(instance, *args, **kwargs)
            except AssertionError:
                evidence.assertions.append("mismatch")
                raise
            else:
                evidence.assertions.append("pass")
                return result
        return wrapper

    selected = evidence.static.comparison.removeprefix("self.")
    stack.enter_context(mock.patch.object(case_class, selected, observe(selected, getattr(case_class, selected))))
    if selected == "assertRaises":
        context = unittest.case._AssertRaisesContext
        original = context.__exit__

        def exit_raises(instance, exc_type, exc, tb):
            if evidence.case_frame(sys._getframe(1)) is None:
                return original(instance, exc_type, exc, tb)
            instance_origin = evidence.origin(tb)
            evidence.exception_origin = instance_origin
            if exc_type is not None and not instance_origin:
                evidence.error = "Exception did not originate in the entry"
            try:
                passed = original(instance, exc_type, exc, tb)
            except AssertionError:
                evidence.assertions.append("mismatch")
                raise
            evidence.assertions.append("pass" if passed else "mismatch")
            return passed
        stack.enter_context(mock.patch.object(context, "__exit__", exit_raises))


def run_case(evidence, config: dict) -> dict:
    result = Result(evidence)
    evidence.exception_origin = False
    evidence.install_path_monitor()
    evidence.monitoring = True
    try:
        with ExitStack() as stack:
            enter_assertion_hooks(stack, evidence)
            name = Path(evidence.file).stem
            spec = importlib.util.spec_from_file_location(name, evidence.file)
            require(spec is not None and spec.loader is not None, "Cannot load evidence test")
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            try:
                spec.loader.exec_module(module)
            except Exception as error:
                absence = evidence.classify_absence(error, error.__traceback__)
                return evidence.result("absent" if absence else "error", absence=absence,
                                       reason=None if absence else "Unittest test import failed")
            test_class = vars(module).get(evidence.static.class_name)
            require(isinstance(test_class, type), "Unittest class was not loaded")
            case = test_class(evidence.static.method)
            test_id = evidence.case["testId"]
            allowed_ids = {
                case.id(), evidence.static.method,
                f"{evidence.static.class_name}.{evidence.static.method}",
                f"{evidence.static.class_name}::{evidence.static.method}",
                f"{evidence.case['testFile']}::{evidence.static.class_name}::{evidence.static.method}",
            }
            require(test_id in allowed_ids, "Unittest loaded a different test")
            with evidence.profiler():
                case.run(result)
    finally:
        evidence.monitoring = False
    status = result.status.get(case.id())
    exception_origin = evidence.exception_origin
    absence = None
    if len(result.errors_seen) > 1:
        return evidence.result("error", reason="Unittest recorded multiple failures")
    if result.errors_seen:
        _, error, tb = result.errors_seen[0]
        absence = evidence.classify_absence(error, tb)
        if evidence.origin(tb):
            exception_origin = True
            if not evidence.assertions:
                evidence.assertions.append("mismatch")
    if absence:
        return evidence.result("absent", absence=absence)
    if status == "pass" and evidence.assertions == ["pass"]:
        return evidence.result("pass", exception_origin=exception_origin)
    if status == "fail" and evidence.assertions == ["mismatch"]:
        return evidence.result("mismatch", exception_origin=exception_origin)
    return evidence.result("error", reason="Unittest did not complete the designated assertion")
