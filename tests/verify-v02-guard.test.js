'use strict';

const { createHash } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkProtection, inspectNodeScripts, inspectPython } = require('../scripts/lib/ast-guard');

function snapshot(sources) {
  const files = Object.create(null);
  for (const [file, source] of Object.entries(sources)) {
    const data = Buffer.from(source);
    files[file] = { kind: 'file', mode: 0o644, hash: createHash('sha256').update(data).digest('hex'), data };
  }
  return { files };
}

const CASE = 'tests/test_core.py';
const BASE = `import unittest
from pathlib import PurePath
import pytest
import dataclasses
import os
import sys

class TestCore(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(len([]), 0)

def test_sets():
    assert set() == set()
`;

function expectGuard(before, after, allowed, config = {}) {
  const result = checkProtection(snapshot(before), snapshot(after), config);
  assert.equal(result.ok, allowed, result.violations.join('\n'));
  return result;
}

test('Python AST guard allows additions that do not change existing semantics', () => {
  const added = BASE.replace('from pathlib import PurePath', 'from pathlib import PurePath, Path')
    .replace('    def test_empty(self):', '    def test_full(self):\n        assert [1]\n\n    def test_empty(self):');
  expectGuard({ [CASE]: BASE }, {
    [CASE]: added + `
import json
import unittest
NAMES = ["ac", "b"]
ORDER = sorted(NAMES, key=len)
DATA_DIR = Path(__file__).parent / "data"

@dataclasses.dataclass
class TestData:
    items: list = dataclasses.field(default_factory=list)

    def test_data(self):
        assert self.items == []

@pytest.mark.skipif(sys.platform == "win32", reason="Linux sample")
def test_other():
    assert True
`,
    'tests/more/test_fresh.py': 'def test_fresh():\n    assert True\n',
  }, true, { protectedPaths: ['tests'] });
});

const PYTHON_VIOLATIONS = {
  'reads a newly bound builtin': 'from custom import set\n',
  'adds a wildcard import': 'from custom import *\n',
  'adds module marks': 'pytestmark = pytest.mark.skip\n',
  'registers a plugin': 'pytest_plugins = ["sample"]\n',
  'adds a load_tests hook': 'def load_tests(a, b, c):\n    return b\n',
  'adds a module lifecycle hook': 'def setUpModule():\n    pass\n',
  'modifies environment at module scope': 'os.environ["CONFIG"] = "yes"\n',
  'uses a call initializer with a side effect': '_tz = os.environ.setdefault("TZ", "UTC")\n',
  'uses a no-op binding to hide a call': '_ = sys.path.insert(0, "elsewhere")\n',
  'passes user code as sorting key': 'def record(x):\n    return x\nNAMES = ["b", "a"]\nORDER = sorted(NAMES, key=record)\n',
  'passes a lambda as sorting key': 'NAMES = ["b", "a"]\nORDER = sorted(NAMES, key=lambda n: n)\n',
  'adds an autouse fixture': '@pytest.fixture(autouse=True)\ndef setup():\n    pass\n',
  'adds an implicit decorator call': '@os.system\ndef test_example():\n    pass\n',
  'adds a string condition for pytest evaluation': '@pytest.mark.skipif("True", reason="example")\ndef test_example():\n    pass\n',
};

for (const [name, addition] of Object.entries(PYTHON_VIOLATIONS)) {
  test(`Python guard rejects when change ${name}`, () => {
    expectGuard({ [CASE]: BASE }, { [CASE]: BASE + '\n' + addition }, false);
  });
}

test('existing class lifecycle, referenced self attributes, imports and bodies are protected', () => {
  expectGuard({ [CASE]: BASE }, { [CASE]: BASE.replace(
    '    def test_empty(self):', '    def setUp(self):\n        pass\n    def test_empty(self):',
  ) }, false);
  expectGuard({ [CASE]: BASE }, { [CASE]: BASE.replace('len([])', 'len([1])') }, false);
  expectGuard({ [CASE]: BASE }, { [CASE]: BASE.replace('import PurePath', 'import PurePath as Path') }, false);
  const withAttribute = BASE.replace('len([])', 'self.value');
  expectGuard({ [CASE]: withAttribute }, { [CASE]: withAttribute.replace(
    '    def test_empty(self):', '    value = 0\n    def test_empty(self):',
  ) }, false);
});

test('new conftest permits fresh fixtures but protects loader hooks and visible fixture names', () => {
  const before = {
    'tests/conftest.py': 'from pytest import fixture\n@fixture\ndef original():\n    return 1\n',
    [CASE]: BASE + '\ndef test_builtin(tmp_path):\n    assert tmp_path\n',
  };
  for (const [fixture, allowed] of [['fresh', true], ['original', false], ['tmp_path', true]]) {
    expectGuard(before, {
      ...before,
      'tests/conftest-extra/conftest.py': `from pytest import fixture\n@fixture\ndef ${fixture}():\n    return 2\n`,
    }, allowed);
  }
  expectGuard(before, {
    ...before,
    'conftest.py': 'import pytest as p\n@p.fixture\ndef tmp_path():\n    return 2\n',
  }, false);
  expectGuard(before, {
    ...before, 'tests/sub/conftest.py': 'def pytest_collection_modifyitems(items):\n    items.clear()\n',
  }, false);
  expectGuard(before, {
    ...before,
    [CASE]: before[CASE] + '\n@pytest.fixture(name="tmp_path")\ndef alternate():\n    return 0\n',
  }, false);
});

test('data inside protected paths is immutable while fresh fixtures are allowed', () => {
  const before = { [CASE]: BASE, 'tests/data.csv': '10\n' };
  expectGuard(before, { ...before, 'tests/data-next.csv': '20\n' }, true, { protectedPaths: ['tests'] });
  expectGuard(before, { ...before, 'tests/data.csv': '20\n' }, false, { protectedPaths: ['tests'] });
});

test('only test settings inside multi-purpose files are protected', () => {
  for (const [file, head, section, body] of [
    ['pyproject.toml', '[project]\nname = "sample"\n', '[tool.pytest.ini_options]\n', 'addopts = "-q"\n'],
    ['setup.cfg', '[metadata]\nname = sample\n', '[tool:pytest]\n', 'addopts = -q\n'],
    ['tox.ini', '[tox]\nenv_list = py313\n', '[pytest]\n', 'addopts = -q\n'],
  ]) {
    const original = head + '\n' + section + body;
    const editingMetadata = head.replace(/sample|py313/, 'product');
    expectGuard({ [file]: original }, { [file]: editingMetadata + '\n' + section + body }, true);
    expectGuard({ [file]: original }, { [file]: original.replace('-q', '-x') }, false);
    expectGuard({ [file]: original }, { [file]: head }, false);
    expectGuard({ [file]: head }, { [file]: original }, false);
  }
  expectGuard({}, { 'pytest.ini': '[pytest]\naddopts = -q\n' }, false);
});

test('npm scripts, lifecycle hooks, and local preload are protected transitively', () => {
  function packageFile(scripts) {
    return JSON.stringify({ scripts });
  }
  const scripts = { test: 'npm run test:unit', 'test:unit': 'node --require ./bootstrap.cjs --test specs', lint: 'echo ok' };
  const before = { 'package.json': packageFile(scripts), 'bootstrap.cjs': 'module.exports = {};\n' };
  const protectedResult = expectGuard(before, {
    ...before, 'package.json': packageFile({ ...scripts, lint: 'echo fine' }),
  }, true);
  assert.deepEqual(protectedResult.nodeCommand, {
    file: 'package.json', cwd: '.', args: ['--require', './bootstrap.cjs', 'specs'],
  });
  for (const changed of [
    { 'package.json': packageFile({ ...scripts, 'test:unit': 'node --test' }) },
    { 'package.json': packageFile({ ...scripts, 'pretest:unit': 'node ./bootstrap.cjs' }) },
    { 'bootstrap.cjs': 'module.exports = null;\n' },
  ]) expectGuard(before, { ...before, ...changed }, false);

  const dynamic = snapshot({ 'package.json': packageFile({ test: 'npm run "$CHECK"' }) });
  assert.equal(inspectNodeScripts(dynamic).nodeCommand, null);
  assert.equal(checkProtection(dynamic, dynamic).ok, false);
});

test('Python inventory uses AST inheritance and configured discovery names', () => {
  const result = inspectPython(snapshot({
    'pyproject.toml': '[tool.pytest.ini_options]\npython_files = ["spec_*.py"]\npython_classes = ["Spec*"]\npython_functions = ["check_*"]\n',
    'spec_base.py': 'from unittest import TestCase as Parent\nclass Base(Parent):\n    pass\n',
    'spec_core.py': `from spec_base import Base
from unittest import mock
class Derived(Base):
    def test_inherits(self):
        pass
class SpecExtra(object):
    def check_sample(self):
        pass
def check_module():
    pass
`,
    'tests/__init__.py': 'from suite import load_tests\n',
  }));
  assert.equal(result.pytestConfig, 'pyproject.toml');
  assert.deepEqual(result.loadTests, ['tests/__init__.py']);
  assert.deepEqual(result.tests, [
    { file: 'spec_core.py', className: 'Derived', name: 'test_inherits', kind: 'unittest' },
    { file: 'spec_core.py', className: 'SpecExtra', name: 'check_sample', kind: 'pytest' },
    { file: 'spec_core.py', className: null, name: 'check_module', kind: 'pytest' },
  ]);
});
