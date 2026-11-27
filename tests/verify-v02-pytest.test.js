'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, rmrf } = require('./helpers');
const runner = require('../scripts/lib/runners/pytest');

const testFile = 'test_vl_req_example_boundary.py';
const title = 'test_boundary';
const pytest = runner.available();
const value = { kind: 'value', value: { type: 'str', value: 'right' } };

function fixture(t, files) {
  const root = tmpDir('vl-pytest-fixture-');
  t.after(() => rmrf(root));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return root;
}

function run(t, options = {}) {
  const {
    assertion = 'assert boundary("") == "right"', preparation = '',
    source = 'def boundary(x): return "right"\n', expected = value,
    args = [{ type: 'str', value: '' }], kwargs = [], files, src = '', module = 'example',
  } = options;
  const prefix = `import pytest\nfrom ${module} import boundary\ndef ${title}():\n`
    + (preparation ? preparation.split('\n').map(line => '    ' + line + '\n').join('') : '');
  const testSource = prefix + assertion.split('\n').map(line => '    ' + line + '\n').join('');
  const root = fixture(t, {
    ...(source === null ? {} : { [src + module.replaceAll('.', '/') + '.py']: source }),
    ...files,
    [testFile]: testSource,
  });
  return runner.runCase({
    root,
    caseData: {
      input: { args, kwargs }, expected, entry: { module, symbol: 'boundary', call: 'boundary' },
      testFile, testId: testFile + '::' + title, assertion: { line: prefix.split('\n').length },
    },
    config: {},
  });
}

test('pytest fails closed if the Python environment lacks pytest', { skip: pytest }, t => {
  const result = run(t);
  assert.equal(result.status, 'error', JSON.stringify(result));
});

test('pytest records assertion passes and comparison failures with an isolated src module', { skip: !pytest }, t => {
  let result = run(t, { src: 'src/', source: `from pathlib import Path
def boundary(x):
    Path(__file__).resolve()
    return "right"
` });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.modulePath, 'src/example.py');
  assert.equal(result.assertions, 1);
  assert.equal(result.called, true);
  assert.ok(result.references.some(x => x.path === 'src/example.py' && x.metadataOnly));
  result = run(t, { source: 'def boundary(x): return "wrong"\n' });
  assert.equal(result.status, 'mismatch', JSON.stringify(result));
  assert.equal(result.assertions, 1);
});

test('pytest requires exception provenance and distinguishes both missing-module forms from dependencies', { skip: !pytest }, t => {
  const assertion = 'with pytest.raises(ValueError):\n    boundary("")';
  const expected = { kind: 'exception', type: 'ValueError' };
  let result = run(t, { assertion, expected, source: 'def boundary(x): raise ValueError(x)\n' });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.exceptionFromEntry, true);
  result = run(t, { assertion, expected });
  assert.equal(result.status, 'mismatch', JSON.stringify(result));
  result = run(t, { assertion, expected, source: 'def boundary(x): raise KeyError(x)\n' });
  assert.equal(result.status, 'mismatch', JSON.stringify(result));
  assert.equal(result.exceptionFromEntry, true);
  result = run(t, { source: null });
  assert.equal(result.status, 'absent', JSON.stringify(result));
  result = run(t, { source: null, module: 'pkg.example', files: { 'pkg/__init__.py': '' } });
  assert.equal(result.status, 'absent', JSON.stringify(result));
  assert.equal(run(t, { source: 'import absent_dependency\n' }).status, 'error');
});

test('pytest rejects bypasses, wrong arguments, and untraced subprocesses', { skip: !pytest }, t => {
  for (const options of [
    { assertion: 'assert False\nassert boundary("") == "right"' },
    { assertion: 'try:\n    assert boundary("") == "right"\nexcept AssertionError:\n    pass' },
    { assertion: 'assert "right" == "right"' },
    { assertion: 'for _ in range(2):\n    assert boundary("") == "right"' },
    { assertion: 'assert boundary("") == load_expected()' },
    { assertion: 'assert boundary("") == mod.NEW_CONST' },
    { assertion: 'assert boundary("") == helper("")' },
    { preparation: 'monkeypatch.setattr(boundary, "result", 3)' },
    { assertion: 'assert boundary("abc") == "right"' },
    { preparation: 'class Sub(str): pass\nx = Sub("")', assertion: 'assert boundary(x) == "right"' },
    { preparation: 'x = []', assertion: 'assert boundary(x, x) == "right"', args: [{ type: 'list', value: [] }, { type: 'list', value: [] }], source: 'def boundary(*x): return "right"' },
    { source: 'import os\ndef boundary(x): os.system("true"); return "right"\n' },
  ]) assert.equal(run(t, options).status, 'error', JSON.stringify(options));
});

test('pytest uses the public collection configuration and records per-test suite outcomes', { skip: !pytest }, t => {
  const root = fixture(t, {
    'pytest.ini': '[pytest]\npython_files = spec_*.py\n',
    'spec_core.py': 'def test_ok(): assert True\ndef test_bad(): assert False\n',
  });
  const config = { pytestConfig: 'pytest.ini' };
  const discovery = runner.collectSuite({ root, config });
  assert.equal(discovery.ok, true, JSON.stringify(discovery));
  assert.deepEqual(discovery.tests.map(x => x.id), ['spec_core.py::test_ok', 'spec_core.py::test_bad']);
  const suite = runner.runSuite({ root, config, tests: discovery.tests });
  assert.equal(suite.ok, true, JSON.stringify(suite));
  assert.deepEqual(suite.tests.map(x => x.status), ['pass', 'fail']);
});
