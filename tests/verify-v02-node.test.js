'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Repo, hasNativeTestAssert, skipWithoutNativeAssert, skipWithoutLinuxSnapshots, firstSkip } = require('./helpers');
const { parseSource, checkNodeCase } = require('../scripts/lib/runners/node-ast-check');
const { checkNodeProtection } = require('../scripts/lib/runners/node-guard');
const { runCase, runSuite } = require('../scripts/lib/runners/node');
const { begin, finalStatus, verifyCase } = require('../scripts/lib/verify-diff');

const testFile = 'edge.vl_req_12345678.test.mjs';
const typed = (type, value) => ({ type, value });
const input = (...args) => ({ args, kwargs: [] });
const expected = { kind: 'value', value: typed('str', 'fixed') };
const source = (statement, prepare = '', options = '') => [
  "import { test } from 'node:test';",
  "import { edge as api } from './edge.mjs';",
  `test('edge', ${options}async (t) => {`,
  '  t.plan(1);',
  `  ${prepare}`,
  `  ${statement}`,
  '});',
].join('\n');
const caseData = (overrides = {}) => ({
  testFile,
  testId: 'edge',
  assertion: { line: 6 },
  entry: { module: './edge.mjs', symbol: 'edge', call: 'api' },
  input: input(typed('str', '')),
  expected,
  ...overrides,
});


function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-node-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), data);
  }
  return root;
}

test('Node source parser supports ESM, CommonJS, top-level await and class fields', () => {
  assert.equal(parseSource('export const x = await Promise.resolve(1)', 'entry.mjs').body.length, 1);
  assert.equal(parseSource('class X { field = 1; #secret; } module.exports = X;', 'entry.cjs').body.length, 2);
});

test('Node static checker accepts a directly awaited equality and rejects assertion shortcuts', () => {
  const statement = 't.assert.strictEqual(await api(""), "fixed");';
  assert.equal(checkNodeCase(source(statement), caseData()).ok, true);
  assert.equal(checkNodeCase(
    source('t.assert.strictEqual(await api(""), wanted);', 'const wanted = "fixed";'), caseData(),
  ).ok, true);
  assert.equal(checkNodeCase(
    source('t.assert.strictEqual(await api(""), wanted);', 'const wanted = "fixed"; void wanted;'), caseData(),
  ).ok, false);
  const rejected = [
    source('try { t.assert.strictEqual(await api(""), "fixed"); } catch {}'),
    source(statement, 't.assert.ok(true);'),
    source('t.assert.strictEqual(await api(""), JSON.parse("\"fixed\""));'),
    source(statement, 't.assert.strictEqual = () => {};'),
    source(statement, '', '{ skip: true }, '),
    source(statement, 'void api("");'),
    source('const p = t.assert.rejects(api(""), TypeError); await p.catch(() => {});'),
    source('t.assert.strictEqual(api({a: 1, a: 2}), "fixed");'),
    source('t.assert.strictEqual(api(""), "wrong");'),
  ];
  for (const text of rejected) assert.equal(checkNodeCase(text, caseData()).ok, false, text);
});

test('Node guard permits pure tests and values while rejecting hooks, only, skip, mutation and binding changes', () => {
  const before = "import { test } from 'node:test';\ntest('old', () => String(1));\n";
  for (const added of [
    "test('new', () => {});",
    "import { strictEqual } from 'node:assert';",
    'const pure = Object.freeze({ x: 1 });',
  ]) assert.equal(checkNodeProtection(before, before + added, { file: 'test.mjs' }), null, added);
  for (const changed of [
    before + "beforeEach(() => process.exit(0));",
    before + "test.only('new', () => {});",
    before.replace("test('old',", "test('old', { skip: true },"),
    before + "import { String } from './replacement.mjs';",
    before + 'const change = process.env.HOME = "new";',
    before + 'const value = [1].sort(() => process.exit(0));',
  ]) assert.ok(checkNodeProtection(before, changed, { file: 'test.mjs' }), changed);
});

test('Node case measures only the requested assertion and imported function call', { skip: skipWithoutNativeAssert }, (t) => {
  const root = fixture(t, {
    'edge.mjs': 'export const edge = async () => "fixed";',
    [testFile]: source('t.assert.strictEqual(await api(""), "fixed");'),
  });
  const r = runCase({ root, caseData: caseData(), timeoutMs: 5000 });
  assert.equal(r.status, 'pass', JSON.stringify(r));
  assert.equal(r.loaded, true);
  assert.equal(r.called, true);
  assert.equal(r.assertions, 1);
  assert.deepEqual(r.input, input(typed('str', '')));
  assert.equal(r.modulePath, 'edge.mjs');
  const wrongInput = runCase({root, caseData: caseData({input: input(typed('str', 'different'))}), timeoutMs: 5000});
  assert.equal(wrongInput.status, 'error', JSON.stringify(wrongInput));

  fs.writeFileSync(path.join(root, 'edge.mjs'), 'export const edge = () => "old";');
  const mismatch = runCase({ root, caseData: caseData(), timeoutMs: 5000 });
  assert.equal(mismatch.status, 'mismatch', JSON.stringify(mismatch));
});

test('Node suite distinguishes reported pass/fail/skip and records file membership', (t) => {
  const root = fixture(t, {
    'test/old.test.mjs': `import { test } from 'node:test';
      test('pass', () => {});
      test('fail', () => { throw new Error('mismatch'); });
      test('skip', {skip:true}, () => {});
    `,
    'passing.mjs': `import { test } from 'node:test';
      test('pass', () => {});
      test('todo', {todo:true}, () => { throw new Error('pending'); });
    `,
  });
  const passing = runSuite({ root, tests: ['passing.mjs'], timeoutMs: 5000 });
  assert.equal(passing.ok, true, JSON.stringify(passing));
  assert.deepEqual(passing.files, ['passing.mjs']);
  assert.deepEqual(passing.tests.map(({ status }) => status), ['pass', 'skip']);

  const r = runSuite({root, config: {}, timeoutMs: 5000});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.files, ['test/old.test.mjs']);
  assert.deepEqual(r.tests.map(({status}) => status), ['pass', 'fail', 'skip']);
});

test('Node measures a thrown or rejected exception from the actual entry frame', { skip: skipWithoutNativeAssert }, (t) => {
  const root = fixture(t, { 'edge.mjs': '', [testFile]: '' });
  const expected = { kind: 'exception', type: 'RangeError' };
  for (const [statement, implementation] of [
    ['t.assert.throws(() => api(""), RangeError);', 'export function edge() { throw new RangeError("empty"); }'],
    ['await t.assert.rejects(api(""), RangeError);', 'export async function edge() { await 0; throw new RangeError("empty"); }'],
    ['t.assert.throws(() => api(""), RangeError);', 'function decorated() { throw new RangeError("empty"); } export { decorated as edge };'],
  ]) {
    fs.writeFileSync(path.join(root, 'edge.mjs'), implementation);
    fs.writeFileSync(path.join(root, testFile), source(statement));
    const result = runCase({ root, caseData: caseData({ expected }), timeoutMs: 5000 });
    assert.equal(result.status, 'pass', JSON.stringify(result));
    assert.equal(result.exceptionFromEntry, true);
  }

  fs.writeFileSync(path.join(root, 'edge.mjs'), 'export const edge = () => { throw new TypeError("wrong"); };');
  const wrong = runCase({ root, caseData: caseData({ expected }), timeoutMs: 5000 });
  assert.equal(wrong.status, 'mismatch', JSON.stringify(wrong));

  fs.writeFileSync(path.join(root, testFile), source('t.assert.throws(() => api(undefinedName), ReferenceError);'));
  const unrelated = runCase({root, caseData: caseData({expected: {kind: 'exception', type: 'ReferenceError'}}), timeoutMs: 5000});
  assert.equal(unrelated.status, 'error', JSON.stringify(unrelated));
  assert.equal(unrelated.called, false);
});

test('Node rejects non-JSON shapes and shared mutable arguments', { skip: skipWithoutNativeAssert }, (t) => {
  const root = fixture(t, { 'edge.mjs': 'export const edge = () => "fixed";', [testFile]: '' });
  const comparison = 't.assert.strictEqual(api(x), "fixed");';
  const plain = typed('object', [['x', typed('number', 1)]]);
  const cases = [
    '{ x: 1 }',
    'Object.freeze({ x: 1 })',
    'Object.seal({ x: 1 })',
    'Object.preventExtensions({ x: 1 })',
    'Object.defineProperty({}, "x", { value: 1, writable: false, enumerable: true, configurable: true })',
    '{ get x() { throw new Error("getter must not run"); } }',
    'Object.defineProperty({}, "x", { value: 1, writable: true, enumerable: false, configurable: true })',
    '{ x: 1, [Symbol()]: 2 }',
    'new Proxy({ x: 1 }, {})',
    'Object.freeze([])',
  ];
  for (const [i, prepare] of cases.entries()) {
    fs.writeFileSync(path.join(root, testFile), source(comparison, 'const x = ' + prepare + ';'));
    const result = runCase({root, caseData: caseData({input: input(plain)}), timeoutMs: 5000});
    assert.equal(result.status, i ? 'error' : 'pass', prepare + ' ' + JSON.stringify(result));
  }

  for (const [statement, status] of [
    ['t.assert.strictEqual(api(x, x), "fixed");', 'error'],
    ['t.assert.strictEqual(api([], []), "fixed");', 'pass'],
  ]) {
    fs.writeFileSync(path.join(root, testFile), source(statement, 'const x = [];'));
    const result = runCase({root, caseData: caseData({input: input(typed('array', []), typed('array', []))}), timeoutMs: 5000});
    assert.equal(result.status, status, JSON.stringify(result));
  }
});

test('Node captures copy-internal exists, permissions, failed unlink, and promised stat', { skip: skipWithoutNativeAssert }, (t) => {
  const root = fixture(t, {
    'edge.mjs': `import { existsSync, accessSync, unlinkSync, constants } from 'node:fs';
      import { stat } from 'node:fs/promises';
      export async function edge(id) {
        existsSync('data/' + id + '.flag');
        try { accessSync('bin/tool.sh', constants.X_OK); } catch {}
        try { unlinkSync('data/app.lock'); } catch {}
        try { await stat('data/child.flag'); } catch {}
        return 'fixed';
      }`,
    [testFile]: source('t.assert.strictEqual(await api("foo"), "fixed");'),
  });
  const r = runCase({root, caseData: caseData({input: input(typed('str', 'foo'))}), timeoutMs: 5000});
  assert.equal(r.status, 'pass', JSON.stringify(r));
  assert.ok(r.references.some(({path}) => path === 'data/foo.flag'));
  assert.ok(r.references.some(({path, access}) => path === 'bin/tool.sh' && access === fs.constants.X_OK));
  assert.ok(r.references.some(({path}) => path === 'data/app.lock'));
  assert.ok(r.references.some(({path}) => path === 'data/child.flag'));
});

test('Node distinguishes a missing direct module or symbol from an unrelated dependency', (t) => {
  const root = fixture(t, {
    [testFile]: source('t.assert.strictEqual(api(""), "fixed");'),
  });
  const cases = [
    [null, 'module'],
    ['export const other = 1;', 'symbol'],
    ["import './missing-dependency.mjs'; export const edge = () => 'fixed';", null],
  ];
  for (const [implementation, absence] of cases) {
    if (implementation) fs.writeFileSync(path.join(root, 'edge.mjs'), implementation);
    const r = runCase({root, caseData: caseData(), timeoutMs: 5000});
    assert.equal(r.status, absence ? 'absent' : 'error', JSON.stringify(r));
    if (absence) assert.equal(r.absence, absence, JSON.stringify(r));
  }

  const cjsFile = 'edge.vl_req_12345678.test.js';
  fs.writeFileSync(path.join(root, cjsFile), [
    "const { test } = require('node:test');",
    "const { edge: api } = require('./edge.cjs');",
    "test('edge', (t) => {",
    "  t.plan(1);",
    "",
    "  t.assert.strictEqual(api(''), 'fixed');",
    "});",
  ].join('\n'));
  const cjs = caseData({testFile: cjsFile, entry: {module: './edge.cjs', symbol: 'edge', call: 'api'}});
  const missing = runCase({ root, caseData: cjs, timeoutMs: 5000 });
  assert.equal(missing.status, 'absent', JSON.stringify(missing));
  assert.equal(missing.absence, 'module');
  assert.equal(missing.modulePath, 'edge.cjs');
  assert.equal(missing.loaded, false);

  fs.writeFileSync(path.join(root, 'edge.cjs'), "require('./missing-dependency.cjs');");
  const transitive = runCase({ root, caseData: cjs, timeoutMs: 5000 });
  assert.equal(transitive.status, 'error', JSON.stringify(transitive));
  assert.equal(transitive.absence, undefined);

  fs.writeFileSync(path.join(root, 'edge.cjs'), 'module.exports = {};');
  const missingSymbol = runCase({ root, caseData: cjs, timeoutMs: 5000 });
  if (hasNativeTestAssert() && process.platform !== 'win32') {
    assert.equal(missingSymbol.absence, 'symbol', JSON.stringify(missingSymbol));
    assert.equal(missingSymbol.loaded, true);
  } else {
    // Node 18 lacks t.assert; Windows CJS inspector URLs may not classify a
    // missing export as absence=symbol. Either way the case must not be verified.
    assert.notEqual(missingSymbol.status, 'pass', JSON.stringify(missingSymbol));
  }

  fs.writeFileSync(path.join(root, 'edge.cjs'), 'module.exports.edge = () => "fixed";');
  const present = runCase({ root, caseData: cjs, timeoutMs: 5000 });
  if (hasNativeTestAssert() && process.platform !== 'win32') {
    assert.equal(present.status, 'pass', JSON.stringify(present));
    assert.equal(present.modulePath, 'edge.cjs');
    assert.equal(present.loaded, true);
  } else {
    assert.notEqual(present.status, 'pass', JSON.stringify(present));
  }
});

test('verifyCase verifies a CommonJS entry with a changed dependency and records its filesystem calls', { skip: firstSkip(skipWithoutLinuxSnapshots, skipWithoutNativeAssert) }, (t) => {
  const repo = new Repo();
  t.after(() => repo.cleanup());
  repo.write('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  repo.write('baseline.test.js', "require('node:test').test('baseline', () => {});");
  repo.write('data/flag', '');
  repo.write('edge.cjs', [
    "const { existsSync } = require('node:fs');",
    // Keep the caller visible across Node versions with deeper loader stacks.
    'Error.stackTraceLimit = 32;',
    "module.exports.edge = () => existsSync('data/flag') ? require('./value.cjs') : 'missing';",
  ].join('\n'));
  repo.write('value.cjs', 'module.exports = "old";');
  const session = { agent: 'claude', session: repo.sessionId };
  const prompt = 'Correct handling of edge inputs';
  const state = begin(repo.dir, session, {
    mode: 'enforce', runner: 'node', timeoutMs: 15000, protectedPaths: [], includePaths: [],
  }, prompt);
  const name = `edge.vl_${state.id}.test.js`;
  repo.write(name, [
    "const { test } = require('node:test');",
    "const { edge: api } = require('./edge.cjs');",
    "test('edge', (t) => {",
    '  t.plan(1);',
    "  t.assert.strictEqual(api(''), 'fixed');",
    '});',
  ].join('\n'));
  repo.write('value.cjs', 'module.exports = "fixed";');
  const result = verifyCase(repo.dir, session, caseData({
    caseId: 'edge', testFile: name, assertion: { line: 5 },
    entry: { module: './edge.cjs', symbol: 'edge', call: 'api' },
    inputFiles: [],
    candidates: ['empty', 'spaces', 'long'].map((id) => ({
      id, requestQuote: prompt, input: id, boundaryKind: 'size', handled: false,
    })),
    selectedCandidateId: 'empty',
    selectionReason: 'An empty input exercises the boundary',
  }));
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.before, 'mismatch');
  assert.equal(result.later.modulePath, 'edge.cjs');
  assert.deepEqual(result.later.loadedFiles, ['edge.cjs', 'value.cjs']);
  assert.ok(result.later.references.some(({ path }) => path === 'data/flag'));
  assert.equal(finalStatus(repo.dir, session).status, 'verified');
});

test('Node only records string arguments that identify valid existing copy paths', { skip: skipWithoutNativeAssert }, (t) => {
  const strings = ['data/payload.txt', 'data/missing.txt', 'text\\value', 'text\u0000value', '.git/index'];
  const root = fixture(t, {
    'edge.mjs': 'export const edge = () => "fixed";',
    'data/payload.txt': 'sample',
    [testFile]: source(`t.assert.strictEqual(api(${strings.map((value) => JSON.stringify(value)).join(', ')}), "fixed");`),
  });
  const result = runCase({
    root, caseData: caseData({ input: input(...strings.map((value) => typed('str', value))) }), timeoutMs: 5000,
  });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.deepEqual(result.references.map(({ path }) => path), ['data/payload.txt']);
});

test('Node rejects evidence when the entry starts a child process', { skip: skipWithoutNativeAssert }, (t) => {
  const root = fixture(t, {
    'edge.mjs': `import { execFileSync } from 'node:child_process';
      export function edge() {
        execFileSync(process.execPath, ['-e', '']);
        return 'fixed';
      }`,
    [testFile]: source('t.assert.strictEqual(api(""), "fixed");'),
  });
  const result = runCase({ root, caseData: caseData(), timeoutMs: 5000 });
  assert.equal(result.status, 'error', JSON.stringify(result));
  assert.match(result.reason, /child process references/);
});

test('Node uses actual object key order to match case inputs', { skip: skipWithoutNativeAssert }, (t) => {
  const root = fixture(t, {
    'edge.mjs': 'export const edge = () => "fixed";',
    [testFile]: source('t.assert.strictEqual(api({ second: 2, first: 1 }), "fixed");'),
  });
  const entries = [['second', typed('number', 2)], ['first', typed('number', 1)]];
  const run = (pairs) => runCase({
    root, caseData: caseData({ input: input(typed('object', pairs)) }), timeoutMs: 5000,
  });
  assert.equal(run(entries).status, 'pass');
  const result = run([...entries].reverse());
  assert.equal(result.status, 'error', JSON.stringify(result));
  assert.match(result.reason, /actual arguments/);
});

test('Node rejects TypeError from calling an exported non-function as entry evidence', { skip: skipWithoutNativeAssert }, (t) => {
  const root = fixture(t, {
    'edge.mjs': 'export const edge = 42;',
    [testFile]: source('t.assert.throws(() => api(""), TypeError);'),
  });
  const result = runCase({
    root, caseData: caseData({ expected: { kind: 'exception', type: 'TypeError' } }), timeoutMs: 5000,
  });
  assert.equal(result.status, 'error', JSON.stringify(result));
  assert.equal(result.called, false);
});
