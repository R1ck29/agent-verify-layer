'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, rmrf } = require('./helpers');
const runner = require('../scripts/lib/runners/unittest');

const file = 'test_vl_req_example_boundary.py';
const testSource = (body, extra = '') => `import unittest
from example import boundary
${extra}
class Boundary(unittest.TestCase):
    def test_boundary(self):
${body.split('\n').map(line => '        ' + line).join('\n')}
`;

function fixture(t, files) {
  const root = tmpDir('vl-python-fixture-');
  t.after(() => rmrf(root));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return root;
}

function run(t, options = {}) {
  const { body = 'self.assertEqual(boundary(""), "right")', source = 'def boundary(x): return "right"\n',
    expected = { kind: 'value', value: { type: 'str', value: 'right' } },
    args = [{ type: 'str', value: '' }], kwargs = [], extra, files, omit = false, assertionLine = 0 } = options;
  const testFileText = testSource(body, extra);
  const root = fixture(t, { ...(omit ? {} : { 'example.py': source }), ...files, [file]: testFileText });
  return runner.runCase({
    root,
    caseData: {
      input: { args, kwargs }, expected, entry: { module: 'example', symbol: 'boundary', call: 'boundary' },
      testFile: file, testId: 'Boundary.test_boundary',
      assertion: { line: testFileText.split('\n').findIndex(line => line.startsWith('        ') && /assert/.test(line)) + 1 + assertionLine },
    },
    config: {},
  });
}

test('unittest records the designated assertion, actual call and exact input', t => {
  let result = run(t);
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.loaded, true);
  assert.equal(result.called, true);
  assert.equal(result.assertions, 1);
  assert.deepEqual(result.input, { args: [{ type: 'str', value: '' }], kwargs: [] });
  result = run(t, { source: 'def boundary(x): return "wrong"\n' });
  assert.equal(result.status, 'mismatch', JSON.stringify(result));
  assert.equal(result.assertions, 1);
  assert.equal(result.modulePath, 'example.py');
});

test('unittest cannot certify a return value with custom equality', t => {
  const result = run(t, { source: [
    'class CustomResult:',
    '    def __eq__(self, other):',
    '        return True',
    'def boundary(x):',
    '    return CustomResult()',
  ].join('\n') });
  assert.equal(result.status, 'error', JSON.stringify(result));
  assert.match(result.reason, /literal comparison/);
});

test('unittest measures both raises forms, including exception provenance and no-raise failure', t => {
  const expected = { kind: 'exception', type: 'ValueError' };
  for (const body of [
    'with self.assertRaises(ValueError):\n    boundary("")',
    'self.assertRaises(ValueError, boundary, "")',
  ]) {
    const result = run(t, { body, expected, source: 'def boundary(x): raise ValueError(x)\n' });
    assert.equal(result.status, 'pass', JSON.stringify(result));
    assert.equal(result.exceptionFromEntry, true);
    assert.equal(run(t, { body, expected }).status, 'mismatch');
    assert.equal(run(t, { body, expected, source: 'def boundary(x): raise KeyError(x)\n' }).status, 'mismatch');
  }
});

test('unittest rejects assertion-shaped shortcuts and comparison tampering', t => {
  for (const body of [
    'with self.assertRaises(ValueError):\n    boundary(make_input())',
    'try:\n    self.assertEqual(boundary(""), "right")\nexcept AssertionError:\n    pass',
    'self.assertEqual(boundary(""), "right"); self.fail()',
    'assert boundary("") == "right"',
    'with self.subTest():\n    self.assertEqual(boundary(""), "right")',
    'for x in []:\n    self.assertEqual(boundary(x), "right")',
    'self.assertEqual(boundary(""), EXPECTED)',
    'self.assertEqual(boundary(""), load_expected())',
    'setattr(boundary, "changed", True)\nself.assertEqual(boundary(""), "right")',
    'self.addTypeEqualityFunc(str, lambda *args, **kwargs: None)\nself.assertEqual(boundary(""), "right")',
    'getattr(self, "addTypeEqualityFunc")(str, lambda *args, **kwargs: None)\nself.assertEqual(boundary(""), "right")',
  ]) {
    const result = run(t, { body, source: 'def boundary(x): return "wrong"\n' });
    assert.equal(result.status, 'error', body + '\n' + JSON.stringify(result));
  }
  const overridden = run(t, { body: 'self.assertEqual(boundary(""), "right")\n    def assertEqual(self, *args):\n        pass' });
  assert.equal(overridden.status, 'error');
});

test('unittest rejects evidence inconsistent with a bound literal expectation', t => {
  const body = 'globals()["EXPECTED"] = "wrong"\nself.assertEqual(boundary(""), EXPECTED)';
  const extra = 'EXPECTED = "right"';
  const statuses = ['right', 'wrong'].map(returned =>
    run(t, { body, extra, source: `def boundary(x): return "${returned}"\n` }).status);
  assert.deepEqual(statuses, ['error', 'error']);
  const valid = run(t, { body: 'self.assertEqual(boundary(""), EXPECTED)', extra });
  assert.equal(valid.status, 'pass', JSON.stringify(valid));
});

test('unittest verifies ordered typed arguments, disallowing subclass or shared mutable input', t => {
  for (const options of [
    { body: 'self.assertEqual(boundary("wrong"), "right")' },
    { body: 'self.assertEqual(boundary(True), "right")', args: [{ type: 'int', value: 1 }] },
    { body: 'self.assertEqual(boundary(-0.0), "right")', args: [{ type: 'float', value: 0 }] },
    { body: 'self.assertEqual(boundary({"a": 2, "b": 1}), "right")',
      args: [{ type: 'dict', value: [['b', { type: 'int', value: 1 }], ['a', { type: 'int', value: 2 }]] }] },
    { body: 'self.assertEqual(boundary(a=2, b=1), "right")', args: [],
      kwargs: [['b', { type: 'int', value: 1 }], ['a', { type: 'int', value: 2 }]] },
    { body: 'x = []\nself.assertEqual(boundary(x, x), "right")',
      args: [{ type: 'list', value: [] }, { type: 'list', value: [] }] },
    { body: 'class Sub(str): pass\nx = Sub("")\nself.assertEqual(boundary(x), "right")' },
  ]) {
    const result = run(t, { ...options, source: 'def boundary(*args, **kwargs): return "right"\n' });
    assert.equal(result.status, 'error', JSON.stringify(result));
  }
  const independent = run(t, {
    body: 'x = []\ny = []\nself.assertEqual(boundary(x, y), "right")',
    args: [{ type: 'list', value: [] }, { type: 'list', value: [] }],
    source: 'def boundary(*args): return "right"\n',
  });
  assert.equal(independent.status, 'pass', JSON.stringify(independent));
});

test('unittest records existing input paths and accepts strings with invalid path characters', t => {
  const values = ['data/input.txt', 'data/missing.txt', 'tag/with\\separator', 'tag/with\0byte'];
  const result = run(t, {
    body: `self.assertEqual(boundary(${JSON.stringify(values)}), "right")`,
    args: [{ type: 'list', value: values.map(value => ({ type: 'str', value })) }],
    files: { 'data/input.txt': 'data' },
  });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.deepEqual(result.references, [{ path: 'data/input.txt' }]);
});

test('unittest monitors pathlib stat, lstat and failed exists checks', t => {
  const result = run(t, { source: `from pathlib import Path
def boundary(value):
    Path("data/stat.txt").stat()
    Path("data/lstat.txt").lstat()
    return "wrong" if Path("data/missing.flag").exists() else "right"
`, files: { 'data/stat.txt': 'data', 'data/lstat.txt': 'data' } });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.deepEqual(result.references.map(({ path }) => path).sort(), [
    'data/lstat.txt', 'data/missing.flag', 'data/stat.txt',
  ]);
});

test('unittest returns attempted paths, access mode, listing and loaded module metadata', t => {
  const result = run(t, { source: `import os
from pathlib import Path
def boundary(value):
    Path(__file__).resolve()
    Path("data/internal.flag").exists()
    os.access("data/start.sh", os.X_OK)
    os.listdir("data")
    try:
        os.unlink("data/absent")
    except FileNotFoundError:
        pass
    return open("data/input.txt").read()
`, files: { 'data/input.txt': 'right', 'data/start.sh': '# script' } });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  for (const ref of [
    { path: 'example.py', metadataOnly: true },
    { path: 'data/internal.flag' },
    { path: 'data/start.sh', access: 1 },
    { path: 'data', entries: true },
    { path: 'data/absent' },
    { path: 'data/input.txt' },
  ]) assert.ok(result.references.some(r => Object.entries(ref).every(([key, value]) => r[key] === value)), JSON.stringify(result));
});

test('unittest rejects untraced launches and records directly missing target module or symbol', t => {
  for (const source of [
    'import os\ndef boundary(x): os.system("true"); return "right"\n',
    'import subprocess\ndef boundary(x): subprocess.run(["true"]); return "right"\n',
  ]) assert.equal(run(t, { source }).status, 'error');
  let result = run(t, { omit: true });
  assert.equal(result.status, 'absent', JSON.stringify(result));
  assert.equal(result.absence, 'module');
  result = run(t, { source: 'def different(): pass\n' });
  assert.equal(result.status, 'absent', JSON.stringify(result));
  assert.equal(result.absence, 'symbol');
  assert.equal(result.loaded, true);
  assert.equal(run(t, { source: 'import nonexistent_dependency\n' }).status, 'error');
});

const unittestModule = name => `import unittest
class Tests(unittest.TestCase):
    def test_${name}(self): self.assertEqual(1, 1)
`;

test('unittest discovers separate patterns in stable order and executes only the starting IDs', t => {
  const config = { unittestStartDir: 'checks', unittestTopLevelDir: '.', unittestPattern: ['test*.py', '*_test.py'] };
  const root = fixture(t, {
    'checks/__init__.py': '',
    'checks/test_a.py': unittestModule('a'),
    'checks/b_test.py': unittestModule('b'),
  });
  const collected = runner.collectSuite({ root, config });
  assert.equal(collected.ok, true, JSON.stringify(collected));
  assert.deepEqual(collected.tests.map(x => x.id), ['checks.b_test.Tests.test_b', 'checks.test_a.Tests.test_a']);
  fs.writeFileSync(path.join(root, 'checks/test_late.py'), unittestModule('late'));
  const suite = runner.runSuite({ root, config, tests: collected.tests });
  assert.deepEqual(suite.tests.map(x => [x.id, x.status]), collected.tests.map(x => [x.id, 'pass']));
});

test('unittest only credits discovery visits, and checks loader errors', t => {
  const loadTests = 'from samples import Tests\ndef load_tests(loader, tests, pattern): return loader.loadTestsFromTestCase(Tests)\n';
  const root = fixture(t, {
    'samples.py': unittestModule('ok'),
    'pkg/__init__.py': loadTests,
    'unseen/test_suite.py': loadTests,
  });
  const done = runner.collectSuite({ root, config: { loadTests: ['pkg/__init__.py'] } });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(done.visited, ['pkg/__init__.py']);
  assert.equal(done.tests[0].file, 'samples.py');
  const missing = runner.collectSuite({ root, config: { loadTests: ['pkg/__init__.py', 'unseen/test_suite.py'] } });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /unseen\/test_suite.py/);
  fs.writeFileSync(path.join(root, 'test_broken.py'), 'import missing_dependency\n');
  assert.equal(runner.collectSuite({ root, config: {} }).ok, false);
});

test('unittest does not credit an indirect loadTestsFromModule call that supplies a discovery pattern', t => {
  const root = fixture(t, {
    'test_suite.py': `import importlib
def load_tests(loader, tests, pattern):
    module = importlib.import_module("unseen.test_suite")
    return loader.loadTestsFromModule(module, pattern=pattern)
`,
    'unseen/test_suite.py': unittestModule('a') + '\ndef load_tests(loader, tests, pattern): return tests\n',
  });
  const result = runner.collectSuite({ root, config: { loadTests: ['test_suite.py', 'unseen/test_suite.py'] } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual(result.visited, ['test_suite.py']);
});
