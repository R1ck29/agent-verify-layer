"""Compare protected Python sources without importing repository code."""

import ast
import configparser
import fnmatch
import json
import posixpath
import re
import symtable
import sys
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:
    tomllib = None


FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)
IMPORTS = (ast.Import, ast.ImportFrom)
BUILTINS = frozenset(
    "dict list tuple set frozenset str int float bool bytes range len sorted".split()
)
PURE_CALLS = frozenset(
    """
    pathlib.Path pathlib.PurePath os.path.join os.path.dirname os.path.basename
    os.path.abspath re.compile collections.namedtuple dataclasses.field
    typing.TypeVar typing.ParamSpec typing.TypeVarTuple typing.NewType
    typing.NamedTuple typing.TypedDict typing.ForwardRef typing.cast
    """.split()
)
BARE_DECORATORS = frozenset(
    ("dataclasses.dataclass", "staticmethod", "classmethod", "property", "pytest.fixture")
)
MODULE_HOOKS = frozenset(
    """
    pytestmark pytest_plugins load_tests setUpModule tearDownModule
    setup_module teardown_module setup_function teardown_function
    """.split()
)
CLASS_HOOKS = frozenset(
    """
    pytestmark pytest_plugins load_tests setUp setUpClass tearDown tearDownClass
    asyncSetUp asyncTearDown setup_method teardown_method setup_class teardown_class
    """.split()
)
TESTCASE_BASES = frozenset(("unittest.TestCase", "unittest.IsolatedAsyncioTestCase"))
DEFAULT_FILES = ("test*.py", "*_test.py")
CONFIG_FILES = ("pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg")


def atoms(body: list[ast.stmt]) -> list[ast.stmt]:
    result = []
    for statement in body:
        if isinstance(statement, ast.Import):
            result.extend(ast.Import(names=[spec]) for spec in statement.names)
        elif isinstance(statement, ast.ImportFrom):
            result.extend(
                ast.ImportFrom(module=statement.module, names=[spec], level=statement.level)
                for spec in statement.names
            )
        else:
            result.append(statement)
    return result


def notation(node: ast.AST | None) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return notation(node.value) + "." + node.attr
    return ""


def canonical(node: ast.AST | None, aliases: dict[str, str]) -> str:
    head, dot, tail = notation(node).partition(".")
    target = aliases.get(head, head)
    return target + dot + tail if target else ""


def import_aliases(statement: ast.stmt, package: str = "") -> dict[str, str]:
    if isinstance(statement, ast.Import):
        return {
            spec.asname or spec.name.split(".")[0]: (
                spec.name if spec.asname else spec.name.split(".")[0]
            )
            for spec in statement.names
        }
    if isinstance(statement, ast.ImportFrom):
        base = statement.module or ""
        if statement.level:
            parts = package.split(".") if package else []
            ascend = statement.level - 1
            if ascend > len(parts):
                return {}
            base = ".".join(filter(None, [".".join(parts[:len(parts) - ascend]), base]))
        return {
            spec.asname or spec.name: ".".join(filter(None, [base, spec.name]))
            for spec in statement.names
        }
    return {}


def module_aliases(body: list[ast.stmt], package: str = "") -> dict[str, str]:
    aliases: dict[str, str] = {}
    for statement in body:
        for name in bindings(statement):
            aliases[name] = ""
        aliases.update(import_aliases(statement, package))
    return aliases


def targets(node: ast.AST) -> set[str]:
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, (ast.Tuple, ast.List)):
        return set().union(*(targets(item) for item in node.elts))
    if isinstance(node, ast.Starred):
        return targets(node.value)
    return set()


def local_nodes(node: ast.AST) -> Any:
    """Walk statements in the current scope, leaving nested bodies separate."""
    yield node
    if not isinstance(node, (*FUNCTIONS, ast.ClassDef, ast.Lambda)):
        for child in ast.iter_child_nodes(node):
            yield from local_nodes(child)


def direct_bindings(statement: ast.AST) -> set[str]:
    if isinstance(statement, (*FUNCTIONS, ast.ClassDef)):
        return {statement.name}
    if isinstance(statement, IMPORTS):
        return {spec.asname or spec.name.split(".")[0] for spec in statement.names}
    if isinstance(statement, ast.Name) and isinstance(statement.ctx, (ast.Store, ast.Del)):
        return {statement.id}
    if isinstance(statement, ast.ExceptHandler) and statement.name:
        return {statement.name}
    if isinstance(statement, (ast.MatchAs, ast.MatchStar)) and statement.name:
        return {statement.name}
    if isinstance(statement, ast.MatchMapping) and statement.rest:
        return {statement.rest}
    return set()


def bindings(statement: ast.stmt) -> set[str]:
    return set().union(*(direct_bindings(node) for node in local_nodes(statement)))


def fixture_names(body: list[ast.stmt], aliases: dict[str, str]) -> set[str]:
    result = set()
    for node in body:
        if not isinstance(node, FUNCTIONS):
            continue
        for decorator in node.decorator_list:
            callee = decorator.func if isinstance(decorator, ast.Call) else decorator
            if canonical(callee, aliases) != "pytest.fixture":
                continue
            name = node.name
            if isinstance(decorator, ast.Call):
                for key in decorator.keywords:
                    if key.arg == "name" and isinstance(key.value, ast.Constant):
                        if isinstance(key.value.value, str):
                            name = key.value.value
            result.add(name)
    return result


def fixture_reads(tree: ast.Module) -> set[str]:
    result = set()
    for statement in tree.body:
        if isinstance(statement, FUNCTIONS):
            functions = [statement]
        elif isinstance(statement, ast.ClassDef):
            functions = [node for node in statement.body if isinstance(node, FUNCTIONS)]
        else:
            continue
        for function in functions:
            result.update(arg.arg for arg in [
                *function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs
            ] if arg.arg not in ("self", "cls"))
            for decorator in function.decorator_list:
                if not isinstance(decorator, ast.Call) or not notation(decorator.func).endswith(".usefixtures"):
                    continue
                result.update(
                    arg.value for arg in decorator.args
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str)
                )
    return result


def module_reads(source: str, file: str) -> set[str]:
    def visit(table: symtable.SymbolTable) -> set[str]:
        result = {
            symbol.get_name() for symbol in table.get_symbols()
            if symbol.is_referenced() and symbol.is_global()
        }
        for child in table.get_children():
            result.update(visit(child))
        return result

    return visit(symtable.symtable(source, file, "exec"))


def class_reads(body: list[ast.stmt]) -> set[str]:
    result = set()
    for statement in body:
        for node in local_nodes(statement):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                result.add(node.id)
        if isinstance(statement, FUNCTIONS):
            receivers = [*statement.args.posonlyargs, *statement.args.args]
            receiver = receivers[0].arg if receivers else None
            result.update(
                node.attr for node in ast.walk(statement)
                if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load)
                and isinstance(node.value, ast.Name) and node.value.id == receiver
            )
            for expr in definition_expressions(statement):
                result.update(
                    node.id for node in ast.walk(expr)
                    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
                )
        elif isinstance(statement, ast.ClassDef):
            for expr in definition_expressions(statement):
                result.update(
                    node.id for node in ast.walk(expr)
                    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
                )
    return result


def definition_expressions(node: ast.AST) -> list[ast.expr]:
    if isinstance(node, ast.ClassDef):
        return [*node.bases, *(key.value for key in node.keywords)]
    if not isinstance(node, FUNCTIONS):
        return []
    args = node.args
    all_args = [*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg]
    return [
        expr for expr in [
            *args.defaults, *args.kw_defaults,
            *(arg.annotation for arg in all_args if arg is not None), node.returns
        ]
        if expr is not None
    ]


def same_ast(left: ast.AST, right: ast.AST) -> bool:
    return ast.dump(left) == ast.dump(right)


def same_class(left: ast.stmt, right: ast.stmt) -> bool:
    if not isinstance(left, ast.ClassDef) or not isinstance(right, ast.ClassDef):
        return False
    left_header = {key: value for key, value in ast.iter_fields(left) if key != "body"}
    right_header = {key: value for key, value in ast.iter_fields(right) if key != "body"}
    return same_ast(ast.ClassDef(**left_header, body=[]), ast.ClassDef(**right_header, body=[]))


def constant_shape(
    node: ast.AST, aliases: dict[str, str], values: set[str], *, mark: bool = False
) -> bool:
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, ast.Name):
        return node.id in values or node.id == "__file__"
    if isinstance(node, ast.Attribute):
        if mark:
            name = notation(node).partition(".")[0]
            if name and aliases.get(name):
                return True
        return constant_shape(node.value, aliases, values, mark=mark)
    if isinstance(node, ast.Call):
        return pure_call(node, aliases, values)
    if isinstance(node, ast.Dict) and any(key is None for key in node.keys):
        return False
    if isinstance(node, (
        ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.Subscript, ast.Slice,
        ast.Tuple, ast.List, ast.Dict, ast.Set,
    )):
        return all(
            constant_shape(child, aliases, values, mark=mark)
            for child in ast.iter_child_nodes(node) if isinstance(child, ast.expr)
        )
    return False


def pure_call(
    call: ast.Call, aliases: dict[str, str], values: set[str], *, decorator: bool = False
) -> bool:
    name = canonical(call.func, aliases)
    mark = decorator and name.startswith("pytest.mark.") and name.count(".") == 2
    fixture = decorator and name == "pytest.fixture"
    if name not in BUILTINS and name not in PURE_CALLS and not (mark or fixture):
        return False
    if fixture and (call.args or any(
        key.arg == "autouse" and not (isinstance(key.value, ast.Constant) and key.value.value is False)
        for key in call.keywords
    )):
        return False
    if name in ("pytest.mark.skipif", "pytest.mark.xfail"):
        # Only a statically boolean condition may be handed to pytest. Pytest
        # evaluates a string condition as code, including when bound to a name.
        conditions = [*call.args, *(key.value for key in call.keywords if key.arg == "condition")]
        if any(not isinstance(expr, (ast.Compare, ast.BoolOp, ast.UnaryOp)) and not (
            isinstance(expr, ast.Constant) and type(expr.value) is bool
        ) for expr in conditions):
            return False
        if any(isinstance(expr, ast.BoolOp) for expr in conditions):
            return False
        if any(isinstance(expr, ast.UnaryOp) and not isinstance(expr.op, ast.Not) for expr in conditions):
            return False
    if not all(constant_shape(arg, aliases, values, mark=mark) for arg in call.args):
        return False
    for key in call.keywords:
        if key.arg is None:
            return False
        callback = (name, key.arg) in (("sorted", "key"), ("dataclasses.field", "default_factory"))
        if callback:
            if not isinstance(key.value, ast.Name) or canonical(key.value, aliases) not in BUILTINS:
                return False
        elif not constant_shape(key.value, aliases, values, mark=mark):
            return False
    return True


def safe_expression(expr: ast.expr, aliases: dict[str, str], values: set[str]) -> bool:
    for node in ast.walk(expr):
        if isinstance(node, (ast.NamedExpr, ast.Await, ast.Yield, ast.YieldFrom, ast.Starred)):
            return False
        if isinstance(node, ast.Call) and not pure_call(node, aliases, values):
            return False
    return True


def safe_definition(node: ast.stmt, aliases: dict[str, str], values: set[str]) -> bool:
    if isinstance(node, ast.ClassDef) and node.keywords:
        return False
    for decorator in node.decorator_list:
        if isinstance(decorator, ast.Call):
            if not pure_call(decorator, aliases, values, decorator=True):
                return False
        else:
            name = canonical(decorator, aliases)
            if name not in BARE_DECORATORS and not (
                name.startswith("pytest.mark.") and name.count(".") == 2
            ):
                return False
    return all(safe_expression(expr, aliases, values) for expr in definition_expressions(node))


def pure_assignment(node: ast.stmt, aliases: dict[str, str], values: set[str]) -> set[str] | None:
    if isinstance(node, ast.Assign):
        args = node.targets
    elif isinstance(node, ast.AnnAssign):
        args = [node.target]
        if not safe_expression(node.annotation, aliases, values):
            return None
    else:
        return None

    def plain(target: ast.AST) -> bool:
        return isinstance(target, ast.Name) or (
            isinstance(target, (ast.List, ast.Tuple)) and all(plain(item) for item in target.elts)
        )

    if not all(plain(arg) for arg in args):
        return None
    if node.value is not None and not safe_expression(node.value, aliases, values):
        return None
    if node.value is not None and constant_shape(node.value, aliases, values):
        return set().union(*(targets(arg) for arg in args))
    return set()


def guard_scope(
    old: list[ast.stmt],
    new: list[ast.stmt],
    reads: set[str],
    outer_aliases: dict[str, str],
    outer_values: set[str],
    *,
    scope: str,
    conftest: bool,
    new_conftest: bool = False,
) -> str | None:
    old_atoms = atoms(old)
    original_bindings: dict[str, list[ast.stmt]] = {}
    for node in old_atoms:
        for name in bindings(node):
            original_bindings.setdefault(name, []).append(node)
    known = set(original_bindings)
    aliases = dict(outer_aliases)
    values = set(outer_values)
    index = 0
    for node in atoms(new):
        matched = index < len(old_atoms) and (
            same_ast(old_atoms[index], node) or same_class(old_atoms[index], node)
        )
        added_names = bindings(node)
        imported = import_aliases(node)
        if matched:
            if isinstance(node, ast.ClassDef) and not same_ast(old_atoms[index], node):
                issue = guard_scope(
                    old_atoms[index].body, node.body, class_reads(old_atoms[index].body),
                    aliases, values, scope="class", conftest=conftest,
                )
                if issue:
                    return f"{node.name}: {issue}"
            index += 1
        else:
            if imported and all(
                len(original_bindings.get(name, [])) == 1
                and same_ast(original_bindings[name][0], node)
                and aliases.get(name) == origin
                for name, origin in imported.items()
            ):
                continue
            if added_names & (known | reads):
                return "binding changes existing name resolution: " + ", ".join(
                    sorted(added_names & (known | reads))
                )
            reserved = CLASS_HOOKS if scope == "class" else MODULE_HOOKS
            if added_names & reserved or (conftest and any(name.startswith("pytest_") for name in added_names)):
                return "existing test lifecycle or collection would change"
            if isinstance(node, IMPORTS):
                if "*" in imported or (isinstance(node, ast.ImportFrom) and node.module == "__future__"):
                    return "wildcard imports and future statements can affect existing code"
            elif isinstance(node, (*FUNCTIONS, ast.ClassDef)):
                if not safe_definition(node, aliases, values):
                    return "unsafe import-time definition: " + node.name
                if isinstance(node, ast.ClassDef):
                    if new_conftest:
                        return "a new conftest.py may only declare functions and import names"
                    issue = guard_scope([], node.body, set(), aliases, values, scope="new-class", conftest=False)
                    if issue:
                        return f"{node.name}: {issue}"
            elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                if old or (new_conftest and values):
                    return "new expression in protected scope"
            else:
                pure_values = pure_assignment(node, aliases, values)
                if new_conftest or pure_values is None:
                    return "new import-time side effect in protected scope"
        values.difference_update(added_names)
        for name in added_names:
            aliases[name] = ""
        aliases.update(imported)
        pure_values = pure_assignment(node, aliases, values)
        if pure_values is not None and not matched:
            values.update(pure_values)

    if index != len(old_atoms):
        return "an existing declaration or statement was changed, moved, or removed"
    return None


def parse_sources(sources: dict[str, str]) -> tuple[dict[str, ast.Module], dict[str, str]]:
    trees = {}
    errors = {}
    for file, source in sorted(sources.items()):
        if not file.endswith(".py"):
            continue
        try:
            trees[file] = ast.parse(source, filename=file, type_comments=True)
        except (ValueError, SyntaxError) as error:
            errors[file] = str(error)
    return trees, errors


def directory(file: str) -> str:
    return posixpath.dirname(file)


def under(file: str, base: str) -> bool:
    return not base or file.startswith(base + "/")


def read_config(file: str, source: str) -> dict[str, Any] | None:
    name = posixpath.basename(file)
    if name == "pyproject.toml":
        if tomllib is None:
            raise ValueError("Python tomllib is unavailable")
        tool = tomllib.loads(source).get("tool", {})
        pytest = {key: table for key, table in tool.items() if key.startswith("pytest")}
        return pytest or None

    parser = configparser.ConfigParser(interpolation=None, delimiters=("=",))
    parser.read_string(source)
    section = "tool:pytest" if name == "setup.cfg" else "pytest"
    if name in ("pytest.ini", ".pytest.ini"):
        return dict(parser[section]) if parser.has_section(section) else {}
    return dict(parser[section]) if parser.has_section(section) else None


def config_files(sources: dict[str, str]) -> dict[str, Any]:
    return {
        file: read_config(file, source)
        for file, source in sorted(sources.items()) if posixpath.basename(file) in CONFIG_FILES
    }


def options_for(file: str, settings: dict[str, Any]) -> dict[str, Any]:
    if posixpath.basename(file) != "pyproject.toml":
        return settings
    native = settings.get("pytest", {})
    options = {**native.get("ini_options", {}), **native}
    for key in sorted(settings):
        if key.startswith("pytest."):
            options.update(settings[key])
    return options


def option_patterns(options: dict[str, Any], key: str) -> list[str]:
    value = options.get(key, [])
    if isinstance(value, str):
        return value.split()
    return value if isinstance(value, list) and all(isinstance(x, str) for x in value) else []


def definitions(tree: ast.Module) -> set[str]:
    result = set()
    for node in ast.walk(tree):
        if not isinstance(node, IMPORTS):
            result.update(direct_bindings(node))
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            assigned = node.targets if isinstance(node, ast.Assign) else [node.target]
            result.update(target.attr for target in assigned if isinstance(target, ast.Attribute))
    return result


def module_names(file: str) -> list[str]:
    relative = file[:-3]
    if relative.endswith("/__init__"):
        relative = relative[:-len("/__init__")]
    names = [relative.replace("/", ".")]
    if relative.startswith("src/"):
        names.append(relative[len("src/"):].replace("/", "."))
    return names


def inspect(sources: dict[str, str]) -> dict[str, Any]:
    trees, parse_errors = parse_sources(sources)
    has_pytest_dependency = False
    settings = {}
    for file, source in sources.items():
        name = posixpath.basename(file)
        if name in CONFIG_FILES:
            try:
                config = read_config(file, source)
            except (ValueError, configparser.Error) as error:
                parse_errors[file] = str(error)
                continue
            if config is not None:
                settings[file] = config
        if name == "pyproject.toml" and tomllib is not None:
            try:
                metadata = tomllib.loads(source)
                project = metadata.get("project", {})
                dependency_groups = [
                    project.get("dependencies", []), *project.get("optional-dependencies", {}).values(),
                    *metadata.get("dependency-groups", {}).values(),
                ]
                has_pytest_dependency |= any(
                    isinstance(item, str) and is_pytest_requirement(item)
                    for group in dependency_groups if isinstance(group, list) for item in group
                )
                poetry = metadata.get("tool", {}).get("poetry", {})
                has_pytest_dependency |= any(
                    "pytest" in group for group in [
                        poetry.get("dependencies", {}), poetry.get("dev-dependencies", {}),
                        *(group.get("dependencies", {}) for group in poetry.get("group", {}).values()),
                    ]
                )
            except (ValueError, AttributeError, TypeError) as error:
                parse_errors[file] = str(error)
        elif name.startswith("requirements") or "requirements" in file.split("/")[:-1] or name == "setup.cfg":
            has_pytest_dependency |= any(is_pytest_requirement(line) for line in source.splitlines())
    ranked = sorted(settings, key=lambda file: (
        len(file.split("/")), CONFIG_FILES.index(posixpath.basename(file)), file
    ))
    config = ranked[0] if ranked else None
    options = options_for(config, settings[config]) if config else {}
    patterns = option_patterns(options, "python_files")
    testpaths = option_patterns(options, "testpaths")
    classes = option_patterns(options, "python_classes") or ["Test*"]
    functions = option_patterns(options, "python_functions") or ["test*"]
    test_files = []
    load_tests = []
    aliases = {}
    class_map = {}
    for file, tree in trees.items():
        modules = module_names(file)
        default_name = any(fnmatch.fnmatchcase(posixpath.basename(file), pattern) for pattern in DEFAULT_FILES)
        configured_name = any(fnmatch.fnmatchcase(posixpath.basename(file), pattern) for pattern in patterns)
        in_testpath = not testpaths or any(
            fnmatch.fnmatchcase(prefix, posixpath.normpath(testpath))
            for testpath in testpaths
            for prefix in ("/".join(file.split("/")[:index]) for index in range(1, len(file.split("/")) + 1))
        )
        if default_name or (configured_name and in_testpath):
            test_files.append(file)
        if default_name or posixpath.basename(file) == "__init__.py":
            if any("load_tests" in bindings(statement) for statement in tree.body):
                load_tests.append(file)
        for module in modules:
            package = module if posixpath.basename(file) == "__init__.py" else module.rpartition(".")[0]
            aliases[module] = module_aliases(tree.body, package)
            for statement in tree.body:
                if isinstance(statement, ast.ClassDef):
                    class_map[(module, statement.name)] = statement

    def is_testcase(module: str, name: str, seen: set[tuple[str, str]]) -> bool:
        key = (module, name)
        if key in seen or key not in class_map:
            return False
        known = aliases[module]
        for base in class_map[key].bases:
            reference = canonical(base, {k: v for k, v in known.items() if v})
            if reference in TESTCASE_BASES:
                return True
            imported_module, _, class_name = reference.rpartition(".")
            if class_name and is_testcase(imported_module or module, class_name, seen | {key}):
                return True
        return False

    tests = []
    testcase_files = []
    for file in test_files:
        for statement in trees[file].body:
            if isinstance(statement, FUNCTIONS) and any(fnmatch.fnmatchcase(statement.name, p) for p in functions):
                tests.append({"file": file, "className": None, "name": statement.name, "kind": "pytest"})
            elif isinstance(statement, ast.ClassDef):
                testcase = any(is_testcase(module, statement.name, set()) for module in module_names(file))
                if testcase:
                    testcase_files.append(file)
                elif not any(fnmatch.fnmatchcase(statement.name, p) for p in classes):
                    continue
                kind = "unittest" if testcase else "pytest"
                method_patterns = ["test*"] if testcase else functions
                for node in statement.body:
                    if isinstance(node, FUNCTIONS) and any(fnmatch.fnmatchcase(node.name, p) for p in method_patterns):
                        tests.append({"file": file, "className": statement.name, "name": node.name, "kind": kind})

    return {
        "testFiles": test_files,
        "testcaseFiles": sorted(set(testcase_files)),
        "tests": tests,
        "loadTests": load_tests,
        "hasPytestConfig": bool(settings) or any(
            posixpath.basename(file) == "conftest.py" for file in sources
        ),
        "hasPytestDependency": has_pytest_dependency,
        "pytestConfig": config,
        "pytestOptions": options,
        "parseErrors": parse_errors,
        "definitions": sorted(set().union(*(definitions(tree) for tree in trees.values()))),
    }


def is_pytest_requirement(line: str) -> bool:
    return bool(re.match(r"^\s*pytest(?=\s*[\[<>=!~;@#]|\s*$)", line, re.IGNORECASE))


def compare(before: dict[str, str], after: dict[str, str], protected: list[str]) -> list[str]:
    violations = []
    try:
        old_settings = config_files(before)
        new_settings = config_files(after)
        for file in sorted(old_settings.keys() | new_settings.keys()):
            if old_settings.get(file) != new_settings.get(file):
                violations.append(f"{file}: pytest settings were changed")
    except (ValueError, configparser.Error) as error:
        violations.append(f"could not compare pytest settings: {error}")
    old_trees, old_errors = parse_sources(before)
    new_trees, new_errors = parse_sources(after)
    old_fixtures = {
        file: fixture_names(tree.body, module_aliases(tree.body)) for file, tree in old_trees.items()
    }
    files = set(protected) | {
        file for file in before.keys() | after.keys() if posixpath.basename(file) == "conftest.py"
    }
    for file in sorted(files):
        if before.get(file) == after.get(file):
            continue
        if file in old_errors or file in new_errors:
            violations.append(f"{file}: protected source could not be parsed")
            continue
        if file in before and file not in after:
            violations.append(f"{file}: protected source was deleted")
            continue
        old = old_trees.get(file)
        new = new_trees.get(file)
        if new is None:
            continue
        conftest = posixpath.basename(file) == "conftest.py"
        reads = module_reads(before[file], file) | fixture_reads(old) if old else set()
        issue = guard_scope(
            old.body if old else [], new.body, reads, {}, set(),
            scope="module", conftest=conftest, new_conftest=conftest and old is None,
        )
        if issue:
            violations.append(f"{file}: {issue}")
        introduced = fixture_names(new.body, module_aliases(new.body)) - old_fixtures.get(file, set())
        if old and (conflicts := introduced & fixture_reads(old)):
            violations.append(f"{file}: existing fixtures would be shadowed: {', '.join(sorted(conflicts))}")
        if conftest:
            conflicts = set()
            for prior, names in old_fixtures.items():
                if posixpath.basename(prior) == "conftest.py" and (
                    under(file, directory(prior)) or under(prior, directory(file))
                ):
                    conflicts.update(introduced & names)
                if prior in files and under(prior, directory(file)):
                    conflicts.update(introduced & (fixture_reads(old_trees[prior]) | names))
            if conflicts:
                violations.append(f"{file}: existing fixtures would be shadowed: {', '.join(sorted(conflicts))}")
    return violations


def main() -> None:
    request = json.load(sys.stdin)
    if request["action"] == "inspect":
        result = inspect(request["sources"])
    else:
        result = compare(request["before"], request["after"], request["protected"])
    print(json.dumps(result, sort_keys=True, default=str))


if __name__ == "__main__":
    main()
