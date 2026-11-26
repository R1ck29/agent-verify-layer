'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Repo, VL, run } = require('./helpers');
const { requestTransaction } = require('../scripts/lib/ledger');

function fixture(t, mode, runner = 'node') {
  const repo = new Repo();
  t.after(() => repo.cleanup());
  if (mode) repo.write('.verify-layer.json', JSON.stringify({ verifyV2: { mode, runner } }));
  repo.write('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  repo.write('api.mjs', 'export const edge = () => "old";');
  repo.write('base.test.mjs', [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'test("baseline", () => assert.equal(1, 1));',
  ].join('\n'));
  return repo;
}

const start = (repo, agent = 'claude') => repo.hook(['start', '--agent', agent], {
  hook_event_name: 'UserPromptSubmit', prompt: '空入力の処理を修正する',
});
const stop = (repo, active = false, agent = 'claude') => repo.hook(['stop', '--agent', agent], {
  hook_event_name: 'Stop', stop_hook_active: active,
});
const state = (repo, agent = 'claude') =>
  requestTransaction(repo.dir, agent, repo.sessionId, (current) => current).value;

test('Stop enforces once per request, respects reentry, and resets at UserPromptSubmit', (t) => {
  const repo = fixture(t, 'enforce');
  assert.equal(start(repo).json?.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.equal(state(repo).prompt, '空入力の処理を修正する');
  assert.equal(stop(repo).json, null);
  repo.write('README.md', 'documentation only');
  assert.equal(stop(repo).json, null);
  repo.write('docs/tool.mjs', 'export const code = 1;');
  assert.equal(stop(repo, true).json, null);
  const block = stop(repo);
  assert.equal(block.json?.decision, 'block', block.stderr);
  assert.match(block.json.reason, /inputFiles/);
  assert.match(block.json.reason, /--withdraw/);
  assert.equal(stop(repo, true).json, null);
  assert.equal(stop(repo).json, null);
  assert.equal(state(repo).interventions, 1);
  start(repo);
  repo.write('api.mjs', 'export const edge = () => "next";');
  assert.equal(stop(repo).json?.decision, 'block');
});

test('observe, off, unsupported and missing starts all permit completion', (t) => {
  for (const [mode, runner] of [[undefined, 'node'], ['observe', 'node'], ['enforce','unsupported']]) {
    const repo = fixture(t, mode, runner);
    assert.equal(stop(repo).json, null);
    start(repo);
    repo.write('api.mjs', 'export const edge = () => "new";');
    assert.equal(stop(repo).json, null);
    if (runner === 'unsupported') assert.equal(state(repo).stop.label, '未検証（対応外ランナー）');
    if (mode === 'observe') assert.equal(state(repo).stop.label, '未検証');
  }
});

test('verify-diff CLI supplies evidence for the exact final Stop snapshot', (t) => {
  const repo = fixture(t, 'enforce');
  const opened = start(repo, 'codex');
  const request = opened.json?.hookSpecificOutput?.additionalContext.match(/req_[a-z0-9_]+/)?.[0];
  assert.ok(request, opened.stderr);
  const testFile = `edge.vl_${request}.test.mjs`;
  repo.write(testFile, [
    'import { test } from "node:test";',
    'import { edge } from "./api.mjs";',
    'test("edge", (t) => {',
    '  t.plan(1);',
    '  t.assert.strictEqual(edge(""), "fixed");',
    '});',
  ].join('\n'));
  const typed = (type, value) => ({ type, value });
  const data = {
    caseId: 'edge', candidates: ['empty','large','space'].map(id => ({
      id, requestQuote: '空入力の処理を修正する', input: id, boundaryKind: 'size', handled: false,
    })),
    selectedCandidateId: 'empty', selectionReason: 'The empty input exercises the boundary',
    entry: {module: './api.mjs', symbol: 'edge', call: 'edge'}, input: {args:[typed('str','')], kwargs:[]},
    expected: {kind: 'value', value: typed('str', 'fixed')},
    inputFiles: [], testFile, testId: 'edge', assertion: {line: 5},
  };
  const filename = path.join(repo.home, 'case.json');
  require('node:fs').writeFileSync(filename, JSON.stringify(data));
  repo.write('api.mjs', 'export const edge = () => "fixed";');
  const result = run(process.execPath, [VL, 'verify-diff', '--agent', 'codex', '--session', repo.sessionId,
    '--request', request, '--case', filename], { cwd: repo.dir, env: repo.env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).boundary, true);
  assert.equal(stop(repo, false, 'codex').json, null);
  assert.equal(state(repo, 'codex').stop.label, '検証済み');
  repo.write('api.mjs', 'export const edge = () => "new";');
  assert.equal(stop(repo, false, 'codex').json?.decision, 'block');
});
