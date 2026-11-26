'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Repo } = require('./helpers');
const { requestPath } = require('../scripts/lib/ledger');
const { begin, verifyCase, withdrawCase, finalStatus, recordIntentional } = require('../scripts/lib/verify-diff');
const { promptHasInput } = require('../scripts/lib/case-policy');

const session = { agent: 'claude', session: 'test-session' };
const config = { mode: 'enforce', runner: 'node', timeoutMs: 5000, protectedPaths: [], includePaths: [] };
const value = { type: 'str', value: '' };

function fixture(t, tests = []) {
  const repo = new Repo();
  t.after(() => repo.cleanup());
  repo.write('api.mjs', 'export const edge = () => "wrong";');
  for (const {file} of tests) repo.write(file, '// public test');
  const state = begin(repo.dir, session, config, '空文字の処理を直す', {
    detectRunner: () => ({config, tests, files: tests.map(({file}) => file)}),
  });
  const testFile = `probe.vl_${state.id}.test.mjs`;
  repo.write(testFile, '// additional test');
  const data = {
    caseId: 'one', entry: { module: './api.mjs', symbol: 'edge', call: 'edge' },
    input: { args: [value], kwargs: [] },
    expected: { kind: 'value', value: {type: 'str', value: 'fixed'} },
    inputFiles: [], testFile, testId: 'edge', assertion: { line: 1 },
    candidates: ['empty', 'long', 'spaces'].map(id => ({
      id, requestQuote: '空文字の処理を直す', input: id, boundaryKind: 'size', handled: false,
    })),
    selectedCandidateId: 'empty', selectionReason: 'Boundary behavior',
  };
  return {repo, data, state};
}

function runner(data, references = []) {
  return {
    runCase: ({ root }) => {
      const actual = fs.readFileSync(path.join(root, 'api.mjs'), 'utf8');
      return { status: actual.includes('fixed') ? 'pass' : 'mismatch',
        loaded: true, called: true, assertions: 1, input: data.input, modulePath: 'api.mjs', references };
    },
    runSuite: () => ({ok: true, tests: []}),
  };
}

test('fixed failures clear only with passing evidence on the final snapshot', (t) => {
  const {repo, data} = fixture(t);
  const options = { runner: runner(data) };
  let result = verifyCase(repo.dir, session, data, options);
  assert.equal(result.status, 'mismatch');
  assert.deepEqual(result.openFailures, ['one']);
  repo.write('api.mjs', 'export const edge = () => "fixed";');
  assert.throws(() => verifyCase(repo.dir, session, { ...data, expected: {kind:'exception', type:'Error'} }, options), /caseId/);
  result = verifyCase(repo.dir, session, data, options);
  assert.equal(result.status, 'pass');
  assert.equal(finalStatus(repo.dir, session).status, 'verified');
  repo.write('api.mjs', 'export const edge = () => "changed";');
  assert.equal(finalStatus(repo.dir, session).status, 'stale');
});

test('references must agree across snapshots and a withdrawal prevents verification', (t) => {
  const {repo, data} = fixture(t);
  repo.write('data.txt', 'new data');
  assert.equal(verifyCase(repo.dir, session, data, { runner: runner(data, [{path:'data.txt'}]) }).status, 'error');
  assert.throws(() => withdrawCase(repo.dir, session, 'one', 'incorrect expectation'), /open/);
  const withInput = {...data, inputFiles: ['data.txt']};
  assert.equal(verifyCase(repo.dir, session, withInput, {runner: runner(data, [{path:'data.txt'}])}).status, 'mismatch');
  repo.write('data.txt', 'changed data');
  assert.throws(() => verifyCase(repo.dir, session, withInput, {runner: runner(data)}), /caseId/);
  withdrawCase(repo.dir, session, 'one', 'incorrect expectation');
  assert.equal(finalStatus(repo.dir, session).status, 'withdrawn');
});

test('case limit is shared across calls and a fresh request resets it', (t) => {
  const {repo, data, state} = fixture(t);
  const options = { runner: runner(data) };
  for (const caseId of ['one', 'two', 'three']) verifyCase(repo.dir, session, {...data,caseId}, options);
  assert.throws(() => verifyCase(repo.dir, session, {...data,caseId:'four'}, options), /3/);
  const next = begin(repo.dir, session, config, '次の依頼', { detectRunner: () => ({config, tests: [], files: []}) });
  assert.deepEqual(next.cases, {});
  const archived = JSON.parse(fs.readFileSync(requestPath(repo.dir, state.id + '.state.json'), 'utf8'));
  assert.deepEqual(archived.attempts.map(({ caseId }) => caseId), ['one', 'two', 'three']);
});

test('a reproduced public regression is retried as a full suite and can be recorded as intentional', (t) => {
  const old = { id:'public.test.mjs::baseline', file:'public.test.mjs' };
  const {repo, data} = fixture(t, [old]);
  repo.write('api.mjs', 'export const edge = () => "fixed";');
  const fake = runner(data);
  const invocations = [];
  fake.runSuite = ({ tests }) => {
    invocations.push(tests);
    return { ok: true, tests: [{ ...old, status: invocations.length === 1 ? 'pass' : 'fail' }] };
  };
  const result = verifyCase(repo.dir, session, data, { runner: fake });
  assert.deepEqual(invocations, [[old], [old], [old]]);
  assert.deepEqual(result.suites.regressions, [old.id]);
  assert.equal(finalStatus(repo.dir, session).status, 'unverified');
  assert.throws(() => recordIntentional(repo.dir, session, old.id, 'unrelated', 'conflict'), /request quote/);
  recordIntentional(repo.dir, session, old.id, '空文字の処理を直す', 'The old expectation conflicts with the requested behavior');
  assert.equal(finalStatus(repo.dir, session).status, 'intentional');
});

test('an explicit multi-argument example counts as non-boundary without backticks', () => {
  for (const runner of ['node', 'unittest']) {
    const input = {args: [value, {type: runner === 'node' ? 'number' : 'int', value: 3}], kwargs: []};
    assert.equal(promptHasInput('For example, edge("", 3) should return a value.', input, runner), true);
    assert.equal(promptHasInput('A description with no example call.', input, runner), false);
  }
});

test('a data file loaded as CommonJS cannot be injected as an input file', (t) => {
  const {repo, data} = fixture(t);
  repo.write('helper.data', 'module.exports = "fixed";');
  repo.write('api.mjs', [
    'import { createRequire } from "node:module";',
    'const require = createRequire(import.meta.url);',
    'export const edge = () => require("./helper.data");',
  ].join('\n'));
  repo.write(data.testFile, [
    'import { test } from "node:test";',
    'import { edge } from "./api.mjs";',
    'test("edge", (t) => {',
    '  t.plan(1);',
    '  t.assert.strictEqual(edge(""), "fixed");',
    '});',
  ].join('\n'));
  const result = verifyCase(repo.dir, session, {...data, inputFiles: ['helper.data'], assertion: {line: 5}});
  assert.equal(result.status, 'error', JSON.stringify(result));
  assert.match(result.reason, /loaded as code/);
  assert.equal(finalStatus(repo.dir, session).status, 'unverified');
});
