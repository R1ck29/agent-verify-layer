"""Static and runtime evidence shared by pytest and unittest."""

import ast
import base64
import builtins
from contextlib import contextmanager
from dataclasses import dataclass
from dis import opname
import inspect
import math
import os
from pathlib import Path
import sys
import types


class UnsupportedEvidence(ValueError):
    """The observed execution cannot serve as verification evidence."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise UnsupportedEvidence(message)


def copy_path(root: Path, value: str) -> Path:
    require(isinstance(value, str) and bool(value), "Invalid repository path")
    path = Path(value)
    require(not path.is_absolute() and ".." not in path.parts, "Invalid repository path")
    root = Path(root).resolve()
    result = (root / path).resolve()
    require(result.is_relative_to(root), "Path escapes the copy")
    return result


def qualified(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        root = qualified(node.value)
        return root + "." + node.attr if root else ""
    return ""


def import_names(tree: ast.Module) -> dict[str, str]:
    names = {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                base = alias.name.split(".")[0]
                names[alias.asname or base] = alias.name if alias.asname else base
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
            for alias in node.names:
                require(alias.name != "*", "Wildcard imports are unsupported")
                names[alias.asname or alias.name] = node.module + "." + alias.name
    return names


def imported_name(name: str, aliases: dict[str, str]) -> str:
    base, _, attrs = name.partition(".")
    return ".".join(filter(None, (aliases.get(base, base), attrs)))


def typed(value: object, seen: set[int], *, expected: bool = False) -> dict:
    kind = type(value)
    if value is None:
        return {"type": "none", "value": None}
    if kind is bool:
        return {"type": "bool", "value": value}
    if kind is int:
        require(abs(value) <= (2 ** 53 - 1), "Integer is outside the exact JSON range")
        return {"type": "int", "value": value}
    if kind is float and math.isfinite(value):
        require(value != 0 or math.copysign(1, value) > 0, "Negative zero is outside the exact JSON range")
        return {"type": "float", "value": value}
    if kind is str:
        return {"type": "str", "value": value}
    if kind is bytes:
        return {"type": "bytes", "value": base64.b64encode(value).decode("ascii")}
    if kind in (list, dict):
        require(id(value) not in seen, "Input shares a mutable reference")
        seen.add(id(value))
    if kind in (list, tuple):
        return {"type": "list" if expected else kind.__name__,
                "value": [typed(item, seen, expected=expected) for item in value]}
    if kind is dict:
        require(all(type(key) is str for key in value), "Input dictionary has a non-string key")
        return {"type": "dict", "value": [[key, typed(item, seen, expected=expected)]
                                         for key, item in value.items()]}
    raise UnsupportedEvidence("Input or expectation has an unsupported Python type")


def literal(node: ast.AST) -> object:
    for item in ast.walk(node):
        if isinstance(item, ast.Dict):
            keys = [key.value for key in item.keys if isinstance(key, ast.Constant) and type(key.value) is str]
            require(len(keys) == len(item.keys) == len(set(keys)), "Invalid or duplicate dictionary key")
        elif isinstance(item, ast.UnaryOp):
            require(isinstance(item.op, ast.USub) and isinstance(item.operand, ast.Constant)
                    and type(item.operand.value) in (int, float), "Expected a literal")
        else:
            require(isinstance(item, (ast.Constant, ast.List, ast.Tuple, ast.Load, ast.USub)),
                    "Expected a literal")
    try:
        return ast.literal_eval(node)
    except (SyntaxError, ValueError) as error:
        raise UnsupportedEvidence("Expected a literal") from error


def resolve_expectation(node: ast.AST, tree: ast.Module) -> object:
    if isinstance(node, ast.Name):
        name = node.id
        occurrences = [item for item in ast.walk(tree) if isinstance(item, ast.Name) and item.id == name]
        bindings = [stmt.value for stmt in ast.walk(tree)
                    if ((isinstance(stmt, ast.Assign) and len(stmt.targets) == 1
                         and isinstance(stmt.targets[0], ast.Name) and stmt.targets[0].id == name)
                        or (isinstance(stmt, ast.AnnAssign)
                            and isinstance(stmt.target, ast.Name) and stmt.target.id == name))]
        require(len(occurrences) == 2 and len(bindings) == 1 and bindings[0] is not None,
                "Expectation must be a literal bound exactly once")
        require(import_names(tree).get(name) is None, "Expectation cannot be imported")
        node = bindings[0]
    return literal(node)


def assertion_call(node: ast.AST, aliases: dict[str, str]) -> bool:
    if not isinstance(node, ast.Call):
        return False
    raw = qualified(node.func)
    name = imported_name(raw, aliases)
    return name == "pytest.raises" or (
        raw.startswith("self.") and raw.split(".")[-1].startswith(("assert", "fail"))
    )


def static_safety(tree: ast.Module, aliases: dict[str, str], entry_root: str) -> None:
    import_bindings = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                import_bindings.append(alias.asname or alias.name.split(".")[0])
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                require(node.id != entry_root and node.id not in aliases, "Imported binding was reassigned")
            require(node.id not in {"monkeypatch", "setattr", "delattr"}, "Test mutates runtime state")
        if isinstance(node, (ast.arg, ast.MatchAs, ast.MatchStar, ast.ExceptHandler)):
            name = node.arg if isinstance(node, ast.arg) else node.name
            require(name != entry_root and name != "monkeypatch" and name not in aliases,
                    "Imported binding was shadowed")
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            require(node.name not in aliases and not node.name.startswith(("assert", "fail")),
                    "Test shadows an imported name or comparison method")
        if isinstance(node, ast.Attribute):
            name = imported_name(qualified(node), aliases)
            require(node.attr not in {"addTypeEqualityFunc", "_type_equality_funcs",
                                     "_getAssertEqualityFunc", "_baseAssertEqual",
                                     "setprofile", "settrace"}
                    and not name.startswith("unittest.mock.patch")
                    and name not in {"pytest.skip", "pytest.xfail", "importlib.reload"},
                    "Test mutates runtime state or skips execution")
        if isinstance(node, (ast.Attribute, ast.Subscript)) and isinstance(node.ctx, (ast.Store, ast.Del)):
            base = node
            while isinstance(base, (ast.Attribute, ast.Subscript)):
                base = base.value
            require(not isinstance(base, ast.Name) or base.id not in aliases and base.id != "self",
                    "Test mutates an imported name or its test case")
        if isinstance(node, ast.Call):
            raw = qualified(node.func)
            name = imported_name(raw, aliases)
            require(not name.startswith("unittest.mock.patch")
                    and name not in {"pytest.skip", "pytest.xfail", "importlib.reload",
                                     "builtins.setattr", "builtins.delattr"},
                    "Test mutates runtime state or skips execution")
    require(import_bindings.count(entry_root) == 1, "Entry must have a single import binding")


@dataclass(frozen=True)
class StaticCase:
    method: str
    class_name: str | None
    assertion: ast.stmt
    entry: str
    args: list[ast.AST]
    kwargs: list[ast.keyword]
    comparison: str
    exception_name: str | None
    expectation: object
    check_return: bool


def check_case(tree: ast.Module, case: dict, runner: str) -> StaticCase:
    aliases = import_names(tree)
    tail = case["testId"].replace("::", ".").split(".")[-1]
    candidates = []
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and (stmt.name.startswith("test") or stmt.name == tail):
            candidates.append((None, stmt))
        if isinstance(stmt, ast.ClassDef):
            for method in stmt.body:
                if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) and (method.name.startswith("test") or method.name == tail):
                    candidates.append((stmt, method))
    require(len(candidates) == 1 and candidates[0][1].name == tail, "Exactly one designated test is required")
    owner, method = candidates[0]
    if runner == "unittest":
        require(owner is not None and len(owner.bases) == 1 and not owner.decorator_list and not owner.keywords
                and imported_name(qualified(owner.bases[0]), aliases) in (
                    "unittest.TestCase", "unittest.IsolatedAsyncioTestCase"),
                "Test case must directly use a standard unittest case")
    elif owner:
        require(not owner.decorator_list, "Test class decorators are unsupported")
    require(all(imported_name(qualified(decorator), aliases) in {"pytest.mark.asyncio", "pytest.mark.anyio"}
                for decorator in method.decorator_list), "Unexpected test decorator")
    start = case["assertion"]["line"]
    hits = [stmt for stmt in method.body if stmt.lineno == start]
    require(len(hits) == 1, "Specified assertion is not a single direct statement")
    stmt = hits[0]
    require(not any(other is not stmt and other.lineno <= stmt.end_lineno and other.end_lineno >= stmt.lineno
                    for other in method.body), "Assertion shares its line with another statement")
    require(case["assertion"].get("endLine", stmt.end_lineno) == stmt.end_lineno, "Unexpected assertion range")
    all_comparisons = [node for node in ast.walk(method)
                       if isinstance(node, ast.Assert) or assertion_call(node, aliases)]
    require(len(all_comparisons) == 1, "Specified test must contain exactly one assertion")

    expected = case["expected"]
    comparison = ""
    exception = None
    expected_node = None
    expectation = None
    if runner == "pytest" and isinstance(stmt, ast.Assert):
        value = stmt.test
        require(isinstance(value, ast.Compare) and len(value.ops) == 1 and stmt.msg is None
                and isinstance(value.ops[0], (ast.Eq, ast.Is)), "Unsupported pytest comparison")
        actual, expected_node = value.left, value.comparators[0]
        comparison = "identity" if isinstance(value.ops[0], ast.Is) else "equality"
    elif isinstance(stmt, ast.With):
        require(len(stmt.items) == 1 and len(stmt.body) == 1 and isinstance(stmt.body[0], ast.Expr)
                and stmt.items[0].optional_vars is None, "Exception comparison must contain one direct call")
        context = stmt.items[0].context_expr
        comparison = "pytest.raises" if runner == "pytest" else "self.assertRaises"
        require(isinstance(context, ast.Call) and imported_name(qualified(context.func), aliases) == comparison
                and len(context.args) == 1 and not context.keywords, "Unsupported exception comparison")
        exception, actual = context.args[0], stmt.body[0].value
    elif runner == "unittest" and isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
        call = stmt.value
        comparison = qualified(call.func)
        if comparison == "self.assertRaises":
            require(len(call.args) >= 2, "Unsupported exception comparison")
            exception, target, *args = call.args
            actual = ast.Call(func=target, args=args, keywords=call.keywords)
        else:
            require(comparison in {"self.assertEqual", "self.assertIs", "self.assertIsNone"}
                    and len(call.args) == (1 if comparison == "self.assertIsNone" else 2)
                    and not call.keywords, "Unsupported unittest comparison")
            actual = call.args[0]
            expected_node = ast.Constant(value=None) if comparison == "self.assertIsNone" else call.args[1]
    else:
        raise UnsupportedEvidence("Unsupported assertion shape")

    if exception is not None:
        name = qualified(exception)
        base = name.split(".")[0]
        standard = vars(builtins).get(name)
        require(bool(name) and (base in aliases or isinstance(standard, type) and issubclass(standard, BaseException))
                and expected.get("kind") == "exception" and name.split(".")[-1] == expected.get("type"),
                "Exception class does not match the case")
        exception_name = name
    else:
        require(expected.get("kind") == "value", "Expected a comparison value")
        expectation = resolve_expectation(expected_node, tree)
        value = typed(expectation, set(), expected=True)
        require(value == expected.get("value"), "Assertion expectation does not match the case")
        if comparison in {"identity", "self.assertIs", "self.assertIsNone"}:
            require(value["type"] in {"none", "bool"}, "Identity comparison only supports None and bool")
        exception_name = None

    if isinstance(actual, ast.Await):
        actual = actual.value
    require(isinstance(actual, ast.Call), "Assertion must call the entry directly")
    entry = qualified(actual.func)
    base = entry.split(".")[0]
    require(base in aliases and imported_name(entry, aliases) == case["entry"]["module"] + "." + case["entry"]["symbol"]
            and entry == case["entry"]["call"], "Assertion calls a different entry")
    static_safety(tree, aliases, base)
    for arg in [*actual.args, *(kw.value for kw in actual.keywords)]:
        if not isinstance(arg, ast.Name):
            literal(arg)
    require(all(kw.arg is not None for kw in actual.keywords), "Expanded arguments are unsupported")
    return StaticCase(method.name, owner.name if owner else None, stmt, entry,
                      actual.args, actual.keywords, comparison, exception_name, expectation,
                      isinstance(expected_node, ast.Name))


def in_repo(root: str, pathname: str) -> bool:
    # String prefix only: this runs under path audit hooks, so it must not stat.
    root_n = os.path.normcase(os.path.normpath(root))
    path_n = os.path.normcase(os.path.normpath(pathname))
    return path_n == root_n or path_n.startswith(root_n + os.sep)


def relative_to_root(root: str, pathname: str) -> str:
    return Path(os.path.relpath(pathname, root)).as_posix()


def resolve_binding(frame: types.FrameType, name: str) -> object:
    base, *attributes = name.split(".")
    value = frame.f_locals.get(base, frame.f_globals.get(base, frame.f_builtins.get(base)))
    for attr in attributes:
        value = inspect.getattr_static(value, attr)
    return value


def function_code(binding: object) -> types.CodeType | None:
    if isinstance(binding, (classmethod, staticmethod, types.MethodType)):
        binding = binding.__func__
    if isinstance(binding, types.FunctionType):
        return binding.__code__
    if isinstance(binding, type):
        for name in ("__new__", "__init__"):
            code = function_code(inspect.getattr_static(binding, name))
            if code is not None:
                return code
    return None


class CaseEvidence:
    def __init__(self, root: Path, case: dict, runner: str):
        root = Path(root).resolve()
        self.root = str(root)
        self.file = str(copy_path(root, case["testFile"]))
        self.case = case
        text = Path(self.file).read_bytes()
        self.tree = ast.parse(text, filename=self.file)
        self.static = check_case(self.tree, case, runner)
        self.references = {}
        self.error = None
        self.assertions = []
        self.frames = {}
        self.inputs = []
        self.value_matches = None
        self.monitoring = False
        self.inside_hook = False
        self.getcwd = os.getcwd
        self.readlink = os.readlink
        self.realpath = os.path.realpath
        self.is_profile = self.profile
        self.stat = os.stat
        self.lstat = os.lstat
        self.loaded_module_paths = set()

    def case_frame(self, frame: types.FrameType | None) -> types.FrameType | None:
        while frame is not None:
            if frame.f_code.co_filename == self.file:
                return frame if (
                    frame.f_code.co_name == self.static.method
                    and self.static.assertion.lineno <= frame.f_lineno <= self.static.assertion.end_lineno
                ) else None
            frame = frame.f_back
        return None

    def location(self, module: types.ModuleType | None) -> str | None:
        if not isinstance(module, types.ModuleType):
            return None
        pathname = vars(module).get("__file__")
        if not isinstance(pathname, str):
            return None
        real = self.realpath(pathname)
        return relative_to_root(self.root, real) if in_repo(self.root, real) and real != self.root else None

    def module_path(self) -> str | None:
        return self.location(sys.modules.get(self.case["entry"]["module"]))

    def user_frame(self, frame: types.FrameType | None) -> bool:
        while frame is not None:
            filename = frame.f_code.co_filename
            if filename.startswith("<frozen importlib"):
                return False
            if in_repo(self.root, filename):
                return True
            frame = frame.f_back
        return False

    def reference(self, pathname: object, *, dir_fd: int | None = None, entries: bool = False,
                  access: int | None = None, metadata: bool = False) -> None:
        if isinstance(pathname, int):
            return
        if pathname is None:
            pathname = "."
        try:
            raw = os.fsdecode(os.fspath(pathname))
            home = self.getcwd()
            if dir_fd not in (None, -1, -100) and not os.path.isabs(raw):
                home = self.readlink(f"/proc/self/fd/{dir_fd}")
                require(os.path.isabs(home) and not home.endswith(" (deleted)"), "Cannot resolve directory fd")
            raw = os.path.join(home, raw)
            lexical = os.path.normpath(raw)
            real = self.realpath(raw)
            # Preserve a lexical symlink and its destination as separate observations.
            for candidate in dict.fromkeys((lexical, real)):
                if not in_repo(self.root, candidate):
                    continue
                relative = relative_to_root(self.root, candidate)
                if "__pycache__" in Path(relative).parts or candidate == self.file:
                    continue
                metadata_only = metadata and (
                    candidate in self.loaded_module_paths or self.loaded_module(candidate)
                )
                key = (relative, entries, access, metadata_only)
                result = {"path": relative}
                if entries:
                    result["entries"] = True
                if access is not None:
                    result["access"] = access
                if metadata_only:
                    result["metadataOnly"] = True
                self.references[key] = result
        except (OSError, ValueError, TypeError):
            self.error = "Could not resolve a Python path observation"

    def loaded_module(self, path: str) -> bool:
        for module in tuple(sys.modules.values()):
            if not isinstance(module, types.ModuleType):
                continue
            filename = vars(module).get("__file__")
            if type(filename) is str and in_repo(self.root, filename):
                self.loaded_module_paths.add(filename)
                self.loaded_module_paths.add(self.realpath(filename))
        return path in self.loaded_module_paths

    def input_reference(self, value: object) -> None:
        if type(value) is str:
            if not value or "\0" in value or "\\" in value or ".git" in Path(value).parts:
                return
            candidate = os.path.join(self.getcwd(), value)
            if in_repo(self.root, os.path.normpath(candidate)) and os.path.lexists(candidate):
                self.reference(value)
        elif type(value) in (list, tuple):
            for element in value:
                self.input_reference(element)
        elif type(value) is dict:
            for element in value.values():
                self.input_reference(element)

    def profile(self, frame: types.FrameType, event: str, arg: object) -> None:
        if id(frame) in self.frames:
            if event == "return" and self.case["expected"]["kind"] == "value":
                if frame.f_lasti >= 0 and opname[frame.f_code.co_code[frame.f_lasti]] in ("RETURN_VALUE", "RETURN_CONST"):
                    try:
                        typed(arg, set(), expected=True)
                        if self.static.check_return:
                            expectation = self.static.expectation
                            if self.static.comparison in {"identity", "self.assertIs"}:
                                self.value_matches = arg is expectation
                            else:
                                self.value_matches = arg == expectation
                    except (TypeError, ValueError):
                        self.error = "Return value has no supported literal comparison"
            return
        if event != "call":
            return
        case_frame = self.case_frame(frame.f_back)
        if case_frame is None:
            return
        try:
            binding = resolve_binding(case_frame, self.static.entry)
            if function_code(binding) is not frame.f_code:
                return
            module = sys.modules.get(self.case["entry"]["module"])
            if not isinstance(module, types.ModuleType):
                return
            canonical = module
            for segment in self.case["entry"]["symbol"].split("."):
                canonical = inspect.getattr_static(canonical, segment)
            require(function_code(canonical) is frame.f_code, "Runtime entry differs from the imported symbol")
            require(not self.static.check_return or not isinstance(binding, type),
                    "Cannot compare constructor return against a bound expectation")
            self.frames[id(frame)] = frame
            if len(self.frames) != 1:
                raise UnsupportedEvidence("More than one designated entry invocation")

            def argument(node: ast.AST) -> object:
                return resolve_binding(case_frame, node.id) if isinstance(node, ast.Name) else literal(node)

            args = [argument(node) for node in self.static.args]
            kwargs = [(kw.arg, argument(kw.value)) for kw in self.static.kwargs]
            seen = set()
            self.inputs.append({
                "args": [typed(value, seen) for value in args],
                "kwargs": [[name, typed(value, seen)] for name, value in kwargs],
            })
            self.inside_hook = True
            try:
                for value in [*args, *(value for _, value in kwargs)]:
                    self.input_reference(value)
            finally:
                self.inside_hook = False
        except (TypeError, ValueError, AttributeError) as error:
            self.error = str(error) if isinstance(error, UnsupportedEvidence) else "Could not inspect entry arguments"

    def origin(self, tb: types.TracebackType | None) -> bool:
        while tb is not None:
            if self.frames.get(id(tb.tb_frame)) is tb.tb_frame:
                return True
            tb = tb.tb_next
        return False

    def at_test_assertion(self, tb: types.TracebackType | None) -> bool:
        last = None
        while tb is not None:
            last, tb = tb, tb.tb_next
        return bool(last and last.tb_frame.f_code.co_filename == self.file
                    and last.tb_frame.f_code.co_name == self.static.method
                    and self.static.assertion.lineno <= last.tb_lineno <= self.static.assertion.end_lineno)

    def classify_absence(self, error: BaseException, tb: types.TracebackType | None) -> str | None:
        innermost = None
        while tb:
            if not tb.tb_frame.f_code.co_filename.startswith("<frozen importlib"):
                innermost = tb
            tb = tb.tb_next
        if innermost is None or innermost.tb_frame.f_code.co_filename != self.file:
            return None
        direct_import = next((node for node in ast.walk(self.tree)
                              if isinstance(node, (ast.Import, ast.ImportFrom))
                              and node.lineno <= innermost.tb_lineno <= node.end_lineno), None)
        if direct_import is None and not isinstance(error, AttributeError):
            return None
        module = self.case["entry"]["module"]
        imports_target = (
            isinstance(direct_import, ast.ImportFrom) and direct_import.module == module
            or isinstance(direct_import, ast.Import) and any(alias.name == module for alias in direct_import.names)
        )
        if isinstance(error, ModuleNotFoundError) and error.name == module and imports_target:
            parent, _, _ = module.rpartition(".")
            if parent:
                return "module" if self.location(sys.modules.get(parent)) else None
            return "module" if sys.path and sys.path[0] == self.root else None
        if self.module_path() and (
            type(error) is ImportError and error.name == module and imports_target
            or isinstance(error, AttributeError) and self.at_test_assertion(innermost)
        ):
            binding = sys.modules[module]
            try:
                for segment in self.case["entry"]["symbol"].split("."):
                    binding = inspect.getattr_static(binding, segment)
            except AttributeError:
                return "symbol"
        return None

    def install_path_monitor(self) -> None:
        sys.addaudithook(self.audit)
        for name in ("stat", "lstat", "access", "readlink"):
            original = getattr(os, name)
            setattr(os, name, self.stat_wrapper(name, original))
        for name in ("stat", "lstat", "exists"):
            original = getattr(Path, name)
            setattr(Path, name, self.stat_wrapper(name, original))

    def stat_wrapper(self, name: str, original):
        def wrapped(pathname, *args, **kwargs):
            if self.monitoring and not self.inside_hook and self.user_frame(sys._getframe(1)):
                self.inside_hook = True
                try:
                    access = args[0] if name == "access" and args else kwargs.get("mode") if name == "access" else None
                    self.reference(pathname, dir_fd=kwargs.get("dir_fd"), access=access, metadata=True)
                finally:
                    self.inside_hook = False
            return original(pathname, *args, **kwargs)
        return wrapped

    def audit(self, event: str, args: tuple) -> None:
        process = event in PROCESS_EVENTS
        if not self.monitoring or self.inside_hook or not (process or event == "exec" or event in AUDITED_PATHS):
            return
        self.inside_hook = True
        try:
            if event == "exec":
                filename = args[0].co_filename
                if not filename.startswith("<"):
                    source = self.realpath(filename)
                    if source != self.file and in_repo(self.root, source):
                        self.loaded_module_paths.add(source)
                return
            if not self.user_frame(sys._getframe(1)):
                return
            if process:
                self.error = "Child process references were not captured" if self.case_frame(sys._getframe(1)) else (
                    "Process launch outside the designated entry or untraceable")
                return
            if event in AUDITED_PATHS:
                for index, fd_index, entries in AUDITED_PATHS[event]:
                    self.reference(args[index], dir_fd=args[fd_index] if fd_index is not None else None, entries=entries)
        finally:
            self.inside_hook = False

    @contextmanager
    def profiler(self):
        sys.setprofile(self.is_profile)
        try:
            yield
        finally:
            if sys.getprofile() is not self.is_profile:
                self.error = "Entry profiler was replaced"
            sys.setprofile(None)

    def result(self, fallback: str, *, absence: str | None = None, exception_origin: bool = False,
               reason: str | None = None) -> dict:
        module_path = self.module_path()
        status = fallback
        input_data = self.inputs[0] if len(self.inputs) == 1 else None
        if self.error:
            status, reason = "error", self.error
        elif self.static.check_return and (
            status == "pass" and self.value_matches is not True
            or status == "mismatch" and self.value_matches is True
        ):
            status, reason = "error", "Assertion outcome differs from the bound literal expectation"
        elif status in ("pass", "mismatch") and (
            not module_path or len(self.frames) != 1 or len(self.assertions) != 1 or input_data != self.case["input"]
        ):
            status, reason = "error", "Could not match the loaded entry, assertion, or exact typed arguments"
        return {
            "status": status, "loaded": bool(module_path), "called": len(self.frames) == 1,
            "assertions": len(self.assertions), "input": input_data,
            "modulePath": module_path, "absence": absence,
            "exceptionFromEntry": exception_origin,
            "references": list(self.references.values()), "reason": reason,
            "loadedFiles": sorted(relative_to_root(self.root, name) for name in self.loaded_module_paths),
        }


AUDITED_PATHS = {
    "open": [(0, None, False)],
    "os.listdir": [(0, None, True)],
    "os.scandir": [(0, None, True)],
    "glob.glob": [(0, None, True)],
    "os.remove": [(0, 1, False)],
    "os.rmdir": [(0, 1, True)],
    "os.rename": [(0, 2, True), (1, 3, True)],
    "os.mkdir": [(0, 2, False)],
    "os.chdir": [(0, None, False)],
    "os.chmod": [(0, 2, False)],
    "os.chown": [(0, 3, False)],
    "os.utime": [(0, 3, False)],
    "os.truncate": [(0, None, False)],
    "os.link": [(0, 2, False), (1, 3, False)],
    "os.symlink": [(1, 2, False)],
    "os.getxattr": [(0, None, False)],
    "os.listxattr": [(0, None, False)],
    "os.setxattr": [(0, None, False)],
    "os.removexattr": [(0, None, False)],
}

PROCESS_EVENTS = {"subprocess.Popen", "os.system", "os.posix_spawn", "os.spawn",
                  "os.fork", "os.forkpty", "os.exec", "pty.fork"}
