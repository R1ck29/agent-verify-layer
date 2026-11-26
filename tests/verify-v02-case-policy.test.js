'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCase, sameValue, additionAllowed, appearsInPrompt } = require('../scripts/lib/case-policy');

const requestId = 'req_123456789abc';
const value = (type, v) => ({ type, value: v });
function example() {
  return {
    caseId: 'edge',
    candidates: ['empty', 'space', 'wide'].map((id) => ({
      id, requestQuote: 'handle names', input: id, boundaryKind: 'size', handled: false,
    })),
    selectedCandidateId: 'empty',
    selectionReason: 'Empty names enter the first branch.',
    entry: { module: 'sample', symbol: 'normalize', call: 'normalize(text)' },
    input: { args: [value('str', '')], kwargs: [] },
    expected: { kind: 'value', value: value('str', 'none') },
    inputFiles: [],
    testFile: `test_vl_${requestId}_edge.py`,
    testId: 'test_edge',
    assertion: { line: 4 },
  };
}

test('case validation checks names, selected candidates, ordered typed inputs and files', () => {
  const data = example();
  assert.deepEqual(validateCase(data, requestId, 'pytest'), data);
  assert.throws(() => validateCase({ ...data, candidates: data.candidates.slice(1) }, requestId, 'pytest'), /candidates/i);
  assert.throws(() => validateCase({ ...data, selectedCandidateId: 'missing' }, requestId, 'pytest'), /candidate/i);
  assert.throws(() => validateCase({ ...data, testFile: 'test_vl_req_previous_edge.py' }, requestId, 'pytest'), /test file/i);
  assert.throws(() => validateCase({ ...data, inputFiles: ['../outside'] }, requestId, 'pytest'), /path/i);
  assert.throws(() => validateCase({ ...data, input: { args: [value('int', true)], kwargs: [] } }, requestId, 'pytest'), /typed/i);
  const duplicate = value('dict', [['k', value('int', 1)], ['k', value('int', 2)]]);
  assert.throws(() => validateCase({ ...data, input: { args: [duplicate], kwargs: [] } }, requestId, 'pytest'), /typed/i);
  assert.equal(sameValue(value('dict', [['a', value('int', 1)], ['b', value('int', 2)]]),
    value('dict', [['b', value('int', 2)], ['a', value('int', 1)]])), false);
  assert.equal(sameValue(value('int', 1), value('bool', true)), false);
  assert.equal(sameValue({ type: 'str', value: '' }, { value: '', type: 'str' }), true);
});

function allowed(prompt, options = {}) {
  const { quote = prompt, symbol = 'normalize', module = 'report', loaded = 'src/report.py',
    absence = 'symbol', definitions = [], oldFiles = [], newFiles = [loaded], publicTestFiles = [] } = options;
  return additionAllowed({
    prompt, caseData: { entryAdditionQuote: quote, entry: { symbol, module } },
    evidence: { absence }, modulePath: loaded,
    beforeFiles: oldFiles, afterFiles: newFiles, definitions, publicTestFiles,
  });
}

test('addition proof requires an explicit kind, lexical target, and no preexisting matching definition', () => {
  for (const prompt of [
    '新しい関数 `normalize` を追加する',
    '`normalize`という関数を追加する',
    '`normalize()`を追加する',
    'add a new function `normalize`',
    'add a public normalize function',
  ]) assert.equal(allowed(prompt), true, prompt);
  for (const prompt of [
    'normalizeを追加する',
    '出力形式に `normalize` を追加する',
    '選択肢 `normalize` を追加する',
    'Add `normalize` to output formats',
    'add a normalize API key',
    'add a denormalize function',
    '関数 normalize を追加せず修正する',
    '新しい関数 normalize を追加しない',
    '既存の関数 normalize を追加する',
    'normalize は追加せず parse を直す',
    'Add a -normalize API',
    'Add function /normalize',
  ]) assert.equal(allowed(prompt), false, prompt);
  assert.equal(allowed('add a new function normalize', { definitions: ['normalize'] }), false);
  assert.equal(allowed('add a new function normalize. Repair parse.', { quote: 'add a new function normalize. Repair parse.' }), false);
  assert.equal(allowed('add a new function normalize to parser', { definitions: ['parser'] }), false);
  assert.equal(appearsInPrompt('normalizeを追加', 'normalize'), true);
  assert.equal(appearsInPrompt('denormalizeを追加', 'normalize'), false);
});

test('addition proof checks every stated source path across the entire request', () => {
  const quote = '新しい関数 normalize を追加する';
  assert.equal(allowed(`${quote}。配置先は src/report.py。test_report.py を参照。`, {
    quote, oldFiles: ['tests/test_report.py'], publicTestFiles: ['tests/test_report.py'],
  }), true);
  assert.equal(allowed(`${quote}。配置先は src/report.py。`, { quote, loaded: 'tools/report.py' }), false);
  assert.equal(allowed(`${quote}。参照は tools/report.py。配置先は src/report.py。`, { quote }), false);
  assert.equal(allowed(`${quote}。配置先は pkg.report。`, { quote, newFiles: ['pkg/report.py', 'src/report.py'] }), false);
  for (const prompt of ['新しいモジュール report を追加する', 'src/report.py を作成する', 'add module src.report']) {
    assert.equal(allowed(prompt, { absence: 'module' }), true, prompt);
  }
  assert.equal(allowed(quote, { absence: 'module' }), false);
  assert.equal(allowed('src/report.py を作成する', { absence: 'module', loaded: 'tools/report.py' }), false);
  assert.equal(allowed('新しいモジュール report を追加する。配置先は src/report.py。', {
    quote: '新しいモジュール report を追加する', absence: 'module', loaded: 'tools/report.py',
  }), false);
});
