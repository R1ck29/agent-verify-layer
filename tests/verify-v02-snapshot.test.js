'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Repo, tmpDir, rmrf } = require('./helpers');
const { capture, materialize, readSnapshot, persistSnapshot } = require('../scripts/lib/snapshot');
const { requestTransaction, requestId } = require('../scripts/lib/ledger');

function fixture(t) {
  const repo = new Repo();
  t.after(() => repo.cleanup());
  return repo;
}

test('snapshots use working bytes, untracked files, explicit includes and permissions', { skip: process.platform !== 'linux' }, (t) => {
  const repo = fixture(t);
  repo.write('.gitignore', 'ignored/\n');
  repo.write('code.py', 'old');
  repo.write('deleted.py', 'gone');
  repo.commit();
  repo.write('code.py', 'staged');
  repo.git('add', 'code.py');
  repo.write('code.py', 'working');
  repo.write('data/nested.txt', 'input');
  repo.write('ignored/sub/included.txt', 'allowed');
  fs.chmodSync(path.join(repo.dir, 'ignored'), 0o751);
  repo.write('ignored/unlisted.txt', 'excluded');
  const index = fs.readFileSync(path.join(repo.dir, '.git/index'));
  const before = capture(repo.dir, { includePaths: ['ignored/sub'] });
  assert.equal(before.files['code.py'].data.toString(), 'working');
  assert.equal(before.files['data/nested.txt'].data.toString(), 'input');
  assert.ok(before.files['ignored/sub/included.txt']);
  assert.equal(before.files['ignored/unlisted.txt'], undefined);
  fs.chmodSync(path.join(repo.dir, 'code.py'), 0o754);
  fs.rmSync(path.join(repo.dir, 'deleted.py'));
  const after = capture(repo.dir, { includePaths: ['ignored/sub'] });
  assert.notEqual(before.id, after.id);
  assert.equal(after.files['deleted.py'], undefined);
  assert.deepEqual(fs.readFileSync(path.join(repo.dir, '.git/index')), index);
  const copy = materialize(repo.dir, 'req_0123456789ab', after);
  t.after(copy.cleanup);
  assert.equal(fs.statSync(path.join(copy.root, 'code.py')).mode & 0o777, 0o754);
  assert.equal(fs.readFileSync(path.join(copy.root, 'code.py'), 'utf8'), 'working');
  assert.equal(fs.existsSync(path.join(copy.root, '.git')), false);
  assert.equal(fs.statSync(path.join(copy.root, 'ignored')).mode & 0o777, 0o751);
  assert.equal(path.relative(repo.dir, copy.root).startsWith('..'), true);
});

test('snapshots preserve internal links and reject outward links', { skip: process.platform !== 'linux' }, (t) => {
  const repo = fixture(t);
  repo.write('inside/file', 'data');
  fs.symlinkSync(path.join(repo.dir, 'inside/file'), path.join(repo.dir, 'link'));
  const copy = materialize(repo.dir, 'req_0123456789ab', capture(repo.dir));
  t.after(copy.cleanup);
  assert.equal(fs.readFileSync(path.join(copy.root, 'link'), 'utf8'), 'data');
  assert.equal(fs.realpathSync(path.join(copy.root, 'link')), path.join(copy.root, 'inside/file'));
  const outside = tmpDir();
  t.after(() => rmrf(outside));
  fs.symlinkSync(outside, path.join(repo.dir, 'outside'));
  assert.throws(() => capture(repo.dir), /outside|symlink/i);
});

test('private request ledger does not change snapshots and isolates sessions', { skip: process.platform !== 'linux' }, (t) => {
  const repo = fixture(t);
  repo.write('code.py', 'old');
  const before = capture(repo.dir);
  const id = requestId();
  assert.match(id, /^[a-z][a-z0-9_]{7,31}$/);
  assert.notEqual(id, requestId());
  assert.deepEqual(requestTransaction(repo.dir, 'claude', 'one', (state, save) => {
    assert.equal(state, null);
    persistSnapshot(repo.dir, id, before);
    save({ id, prompt: 'repair a boundary', cases: {}, openFailures: {} });
    return id;
  }), { locked: true, value: id });
  assert.deepEqual(readSnapshot(repo.dir, id), before);
  assert.equal(requestTransaction(repo.dir, 'claude', 'other', (state) => state).value, null);
  assert.equal(requestTransaction(repo.dir, 'codex', 'one', (state) => state).value, null);
  assert.equal(requestTransaction(repo.dir, 'claude', 'one', (state) => state.prompt).value, 'repair a boundary');
  assert.equal(capture(repo.dir).id, before.id);
});

test('Node dependencies expand as a separate read-only tree with internal workspace links', { skip: process.platform !== 'linux' }, (t) => {
  const repo = fixture(t);
  repo.write('node_modules/example/index.js', 'dependency');
  repo.write('packages/widget/index.js', 'workspace');
  fs.symlinkSync('../packages/widget', path.join(repo.dir, 'node_modules/widget'));
  const snapshot = capture(repo.dir, { nodeDependencies: true });
  assert.equal(snapshot.files['node_modules/example/index.js'], undefined);
  assert.ok(capture(repo.dir, { includePaths: ['node_modules/example/index.js'] }).files['node_modules/example/index.js']);
  const copy = materialize(repo.dir, 'req_0123456789ab', snapshot, { nodeDependencies: true });
  t.after(copy.cleanup);
  const source = path.join(repo.dir, 'node_modules/example/index.js');
  const installed = path.join(copy.root, 'node_modules/example/index.js');
  assert.equal(fs.readFileSync(installed, 'utf8'), 'dependency');
  assert.notEqual(fs.statSync(source).ino, fs.statSync(installed).ino);
  assert.equal(fs.statSync(installed).mode & 0o222, 0);
  assert.notEqual(fs.statSync(source).mode & 0o222, 0);
  assert.equal(fs.realpathSync(path.join(copy.root, 'node_modules/widget')), path.join(copy.root, 'packages/widget'));
  assert.throws(() => materialize(repo.dir, 'req_0123456789ab', snapshot, {
    nodeDependencies: true, dependencyLimit: 1,
  }), /dependency.*limit/i);
  repo.write('node_modules/example/index.js', 'modified dependency');
  assert.notEqual(capture(repo.dir, { nodeDependencies: true }).id, snapshot.id);
  assert.throws(() => materialize(repo.dir, 'req_0123456789ab', snapshot, { nodeDependencies: true }), /dependency.*changed/i);
});
