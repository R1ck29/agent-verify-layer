'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { VL, Repo, run } = require('./helpers');
const ledger = require('../scripts/lib/ledger');

function age(file) {
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(file, old, old);
}

function fixture(t) {
  const repo = new Repo();
  t.after(() => repo.cleanup());
  return { repo, lock: path.join(path.dirname(repo.ledgerFile()), 'ledger.lock') };
}

const LEDGER = require.resolve('../scripts/lib/ledger');

function leaveDeadLock(repo, lock) {
  const script = 'require(process.argv[1]).withLock(process.cwd(), () => process.exit(0))';
  const held = run(process.execPath, ['-e', script, LEDGER], { cwd: repo.dir, env: repo.env });
  assert.equal(held.status, 0, held.stderr);
  age(lock);
}

test('XREVIEW #9: an aged lock held by a live owner is not taken over', (t) => {
  const { repo, lock } = fixture(t);
  const owner = ledger.withLock(repo.dir, () => {
    age(lock);
    const contender = ledger.withLock(repo.dir, () => assert.fail('lock already held'), { waitMs: 25 });
    assert.deepEqual(contender, { locked: false });
    assert.ok(fs.existsSync(lock), 'owner still holds its lock');
    return 'recorded';
  });
  assert.deepEqual(owner, { locked: true, value: 'recorded' });
  assert.equal(fs.existsSync(lock), false);
});

test('XREVIEW #9: a lock from a confirmed dead owner can be recovered', (t) => {
  const { repo, lock } = fixture(t);
  leaveDeadLock(repo, lock);
  assert.equal(fs.readdirSync(lock).length, 1, 'the interrupted acquisition left its owner marker');
  assert.deepEqual(ledger.withLock(repo.dir, () => 'recovered'), { locked: true, value: 'recovered' });
  assert.equal(fs.existsSync(lock), false);
});

test('XREVIEW new HIGH 3: an old nonempty lock leaves the hook successful and the ledger unchanged', (t) => {
  const { repo, lock } = fixture(t);
  repo.write('src/a.js', 'one\n');
  repo.git('add', '-A');
  const stdout = repo.git('commit', '-m', 'first');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'old-owner'), 'unknown');
  age(lock);
  const options = {
    cwd: repo.dir,
    env: { ...repo.env, VL_LOCK_WAIT_MS: '25' },
    input: JSON.stringify({ cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'git commit -m first' }, tool_response: { stdout } }),
    timeout: 3000,
  };
  const r = run(process.execPath, [VL, 'hook', 'commit'], options);
  assert.equal(r.status, 0, r.error?.message || r.stderr);
  assert.deepEqual(repo.ledger(), []);
  assert.equal(fs.readFileSync(path.join(lock, 'old-owner'), 'utf8'), 'unknown');

  fs.rmSync(lock, { recursive: true });
  const retry = run(process.execPath, [VL, 'hook', 'commit'], options);
  assert.equal(retry.status, 0, retry.error?.message || retry.stderr);
  assert.equal(repo.lastCommitRow()?.sha, repo.git('rev-parse', 'HEAD'));
});

test('XREVIEW new HIGH 3: repeated ENOENT during lock inspection still checks the deadline', (t) => {
  const { repo, lock } = fixture(t);
  fs.mkdirSync(lock, { recursive: true });
  const script = `
    const fs = require('node:fs');
    for (const method of ['statSync', 'readdirSync']) {
      const original = fs[method];
      fs[method] = (file, ...args) => {
        if (file === process.argv[2]) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return original(file, ...args);
      };
    }
    process.stdout.write(JSON.stringify(require(process.argv[1]).withLock(process.cwd(), () => true, { waitMs: 25 })));
  `;
  const r = run(process.execPath, ['-e', script, LEDGER, lock], { cwd: repo.dir, env: repo.env, timeout: 3000 });
  assert.equal(r.status, 0, r.error?.message || r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { locked: false });
});

test('XREVIEW new HIGH 3: a stale lock that cannot be deleted is left without a retry', (t) => {
  const { repo, lock } = fixture(t);
  leaveDeadLock(repo, lock);
  const script = `
    const fs = require('node:fs');
    const rmdir = fs.rmdirSync;
    let attempts = 0;
    fs.rmdirSync = (file, ...args) => {
      if (file !== process.argv[2]) return rmdir(file, ...args);
      attempts++;
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    };
    const result = require(process.argv[1]).withLock(process.cwd(), () => true);
    process.stdout.write(JSON.stringify({ result, attempts }));
  `;
  const r = run(process.execPath, ['-e', script, LEDGER, lock], { cwd: repo.dir, env: repo.env, timeout: 3000 });
  assert.equal(r.status, 0, r.error?.message || r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { result: { locked: false }, attempts: 1 });
  assert.ok(fs.existsSync(lock));
});
