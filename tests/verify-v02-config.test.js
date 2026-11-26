'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Repo } = require('./helpers');
const { loadV2Config } = require('../scripts/lib/config');

test('v2 enforcement needs an explicit valid repository setting', (t) => {
  const repo = new Repo();
  t.after(() => repo.cleanup());
  assert.equal(loadV2Config(repo.dir).mode, 'off');
  repo.write('.verify-layer.json', JSON.stringify({ verifyV2: { runner: 'pytest' } }));
  assert.equal(loadV2Config(repo.dir).mode, 'off');
  repo.write('.verify-layer.json', JSON.stringify({ verifyV2: {
    mode: 'observe', runner: 'unittest', unittestPattern: ['test*.py', '*_test.py'],
  } }));
  assert.equal(loadV2Config(repo.dir).mode, 'observe');
  repo.write('.verify-layer.json', JSON.stringify({ verifyV2: {
    mode: 'enforce', runner: 'unsupported', timeoutMs: 1000, protectedPaths: ['tests'],
  } }));
  const enforce = loadV2Config(repo.dir);
  assert.equal(enforce.mode, 'enforce');
  assert.equal(enforce.runner, 'unsupported');
  assert.equal(enforce.timeoutMs, 1000);
  assert.deepEqual(enforce.protectedPaths, ['tests']);
  for (const bad of [{ adversarial: true }, { runner: 'shell' }, { includePaths: ['../outside'] },
    { timeoutMs: Infinity }, { unittestPattern: ['*'] }, { mode: 'automatic' }]) {
    repo.write('.verify-layer.json', JSON.stringify({ verifyV2: { mode: 'enforce', ...bad } }));
    assert.equal(loadV2Config(repo.dir).mode, 'off', JSON.stringify(bad));
  }
});

test('repository settings cannot be read through a symlink', { skip: process.platform === 'win32' }, (t) => {
  const repo = new Repo();
  t.after(() => repo.cleanup());
  const other = path.join(repo.home, 'external.json');
  fs.writeFileSync(other, '{"verifyV2":{"mode":"enforce","runner":"node"}}');
  fs.symlinkSync(other, path.join(repo.dir, '.verify-layer.json'));
  assert.equal(loadV2Config(repo.dir).mode, 'off');
});
