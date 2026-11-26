'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Repo } = require('./helpers');
const { capture, materialize } = require('../scripts/lib/snapshot');
const { available } = require('../scripts/lib/runners/pytest');
const { detectRunner } = require('../scripts/lib/runner-detection');

const requestId = 'req_detection';
const testcase = 'from unittest import TestCase as Base\nclass Tests(Base):\n    def test_example(self): pass\n';
const doctest = 'from unittest import mock\ndef test_sample(): assert True\n';
const classTest = 'class TestSample(object):\n    def test_sample(self): assert True\n';
const nodeTest = 'require("node:test").test("example", () => {});';
const manifest = (command) => JSON.stringify({ scripts: { test: command } });
const hasPytest = available();

function detect(t, files, config = {}) {
  const repo = new Repo();
  t.after(() => repo.cleanup());
  for (const [file, source] of Object.entries(files)) repo.write(file, source);
  const snapshot = capture(repo.dir, { nodeDependencies: true });
  return detectRunner(snapshot, {
    config,
    withCopy(callback, options) {
      const copy = materialize(repo.dir, requestId, snapshot, options);
      try {
        assert.notEqual(copy.root, repo.dir);
        return callback(copy.root);
      } finally {
        copy.cleanup();
      }
    },
  });
}

test('runner detection chooses unittest and calculates the common package root and discovery patterns', (t) => {
  const result = detect(t, {
    'pkg/__init__.py': '',
    'pkg/tests/__init__.py': '',
    'pkg/tests/test_a.py': testcase,
    'pkg/tests/b_test.py': testcase,
  });
  assert.equal(result.config.runner, 'unittest', result.reason);
  assert.equal(result.config.unittestStartDir, 'pkg/tests');
  assert.equal(result.config.unittestTopLevelDir, '.');
  assert.deepEqual(result.config.unittestPattern, ['test*.py', '*_test.py']);
  assert.deepEqual(result.config.protectedPaths, ['pkg/tests/b_test.py', 'pkg/tests/test_a.py']);
  assert.deepEqual(result.tests.map(({ id }) => id), [
    'pkg.tests.b_test.Tests.test_example', 'pkg.tests.test_a.Tests.test_example',
  ]);
});

test('runner detection recognizes pytest-style functions and classes, even with unittest imports', {
  skip: !hasPytest,
}, (t) => {
  const result = detect(t, {
    'test_a.py': doctest + classTest,
    'test_b.py': testcase,
  });
  assert.equal(result.config.runner, 'pytest', result.reason);
  assert.deepEqual(result.tests.map(({ id }) => id), [
    'test_a.py::test_sample', 'test_a.py::TestSample::test_sample', 'test_b.py::Tests::test_example',
  ]);
});

test('pytest detection includes files containing only inherited TestCase methods', { skip: !hasPytest }, (t) => {
  const result = detect(t, {
    'test_function.py': 'def test_example(): assert True\n',
    'helper.py': testcase,
    'test_child.py': 'import helper\nclass Child(helper.Tests): pass\n',
  });
  assert.equal(result.config.runner, 'pytest', result.reason);
  assert.deepEqual(result.files, ['test_child.py', 'test_function.py']);
  assert.ok(result.tests.some(({ id }) => id === 'test_child.py::Child::test_example'));
});

test('runner detection applies pytest public configuration and reports lost test identifiers', {
  skip: !hasPytest,
}, (t) => {
  const files = {
    'pytest.ini': '[pytest]\npython_files = spec_*.py\npython_functions = check_*\n',
    'spec_core.py': 'def check_sample(): assert True\n',
  };
  let result = detect(t, files);
  assert.equal(result.config.runner, 'pytest', result.reason);
  assert.equal(result.config.pytestConfig, 'pytest.ini');
  assert.deepEqual(result.files, ['spec_core.py']);
  result = detect(t, files, { runner: 'node' });
  assert.equal(result.config.runner, 'unsupported');
  result = detect(t, { 'test_core.py': 'class TestSample:\n    def __init__(self): pass\n    def test_x(self): pass\n' });
  assert.equal(result.config.runner, 'unsupported');
  assert.deepEqual(result.missing, ['test_core.py::TestSample::test_x']);
});

test('runner detection counts Python public configuration and collection errors in mixed repositories', (t) => {
  const files = {
    'package.json': manifest('node --test specs/entry.js'),
    'specs/entry.js': nodeTest,
    'pytest.ini': '[pytest]\npython_files = spec_*.py\n',
  };
  for (const source of ['def test_sample(): assert True\n', 'import missing_public_dependency\n']) {
    const result = detect(t, { ...files, 'spec_core.py': source });
    assert.equal(result.config.runner, 'unsupported');
    assert.match(result.reason, /Python.*Node/);
  }
});

test('runner detection requires discovery visits to every public load_tests file', (t) => {
  const loadTests = 'from samples import Tests\ndef load_tests(loader, tests, pattern): return loader.loadTestsFromTestCase(Tests)\n';
  const single = { 'samples.py': testcase, 'suite_a/test_suite.py': loadTests };
  let result = detect(t, single);
  assert.equal(result.config.runner, 'unittest', result.reason);
  assert.deepEqual(result.config.loadTests, ['suite_a/test_suite.py']);
  assert.deepEqual(result.files, ['samples.py']);
  result = detect(t, { 'samples.py': testcase, 'pkg/__init__.py': loadTests });
  assert.equal(result.config.runner, 'unittest', result.reason);
  assert.equal(result.config.unittestStartDir, '.');
  const two = { ...single, 'suite_b/test_suite.py': loadTests };
  result = detect(t, two);
  assert.equal(result.config.runner, 'unsupported');
  assert.match(result.reason, /Unvisited load_tests files/);
  result = detect(t, { ...two, 'suite_a/__init__.py': '', 'suite_b/__init__.py': '' });
  assert.equal(result.config.runner, 'unittest', result.reason);
  result = detect(t, { ...single, 'package.json': manifest('node --test'), 'demo.test.js': nodeTest });
  assert.equal(result.config.runner, 'unsupported');
  assert.match(result.reason, /Python.*Node/);
});

test('runner detection confirms that the npm Node test command reaches every public file', (t) => {
  let result = detect(t, {
    'package.json': JSON.stringify({ scripts: { test: 'npm run test:unit', 'test:unit': 'node --test specs/entry.js' } }),
    'specs/entry.js': nodeTest,
  });
  assert.equal(result.config.runner, 'node', result.reason);
  assert.deepEqual(result.files, ['specs/entry.js']);
  assert.deepEqual(result.config.nodeCommand.args, ['specs/entry.js']);
  result = detect(t, {
    'package.json': manifest('node --test test/unit/example.test.js'),
    'test/unit/example.test.js': nodeTest,
    'test/integration/example.test.js': nodeTest,
  });
  assert.equal(result.config.runner, 'unsupported');
  assert.deepEqual(result.missing, [path.posix.join('test', 'integration', 'example.test.js')]);
});

test('runner detection rejects cross-language coverage gaps from inherited TestCase methods', (t) => {
  const result = detect(t, {
    'helper.py': testcase,
    'test_child.py': 'import helper\nclass Child(helper.Tests): pass\n',
    'package.json': manifest('node --test'),
    'demo.test.js': nodeTest,
  });
  assert.equal(result.config.runner, 'unsupported');
  assert.match(result.reason, /Python.*Node/);
});

test('runner detection refuses collection when the start-time budget is exhausted', () => {
  const result = detectRunner({ files: {} }, {
    withCopy() { throw new Error('Unexpected copy'); },
    remaining: () => 0,
  });
  assert.equal(result.config.runner, 'unsupported');
  assert.match(result.reason, /budget/i);
  assert.deepEqual(result.tests, []);
});
