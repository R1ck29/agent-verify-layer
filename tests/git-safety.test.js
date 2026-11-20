'use strict';
// XREVIEW #1 (doctor must never touch the caller's repository through inherited GIT_* variables)
// and #7 (a failed snapshot or diff is "unknown", never a normal tree or an empty commit).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Repo, VL, run, tmpDir, rmrf } = require('./helpers');
const git = require('../scripts/lib/git');
const { classify } = require('../scripts/lib/classify');

function snapshot(repo) {
  const g = (...a) => repo.git(...a);
  return {
    head: g('rev-parse', 'HEAD'),
    count: g('rev-list', '--count', '--all'),
    status: g('status', '--porcelain'),
    index: fs.readFileSync(path.join(repo.dir, '.git', 'index')).toString('hex'),
    refs: g('for-each-ref'),
    ledger: fs.existsSync(path.dirname(repo.ledgerFile())),
  };
}

test('XREVIEW #1: doctor does not touch a repository named by inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE', () => {
  const victim = new Repo();
  const cwd = tmpDir('vl-elsewhere-');
  try {
    victim.write('a.js', 'a\n');
    victim.commit('init');
    victim.write('b.js', 'dirty, uncommitted\n');
    const before = snapshot(victim);
    const env = {
      ...victim.env,
      GIT_DIR: path.join(victim.dir, '.git'),
      GIT_WORK_TREE: victim.dir,
      GIT_INDEX_FILE: path.join(victim.dir, '.git', 'index'),
    };
    const r = run(process.execPath, [VL, 'doctor', '--json'], { cwd, env });
    assert.ok(r.stdout.includes('"results"'), r.stdout + r.stderr);
    assert.deepEqual(snapshot(victim), before);
  } finally {
    victim.cleanup();
    rmrf(cwd);
  }
});

test('XREVIEW #1: isolatedGitEnv drops repository-location variables and numbered config entries', () => {
  const env = git.isolatedGitEnv(
    { PATH: 'p', GIT_DIR: 'x', GIT_WORK_TREE: 'x', GIT_INDEX_FILE: 'x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'k', GIT_CONFIG_VALUE_0: 'v', GIT_CONFIG_KEY_2: 'k2', GIT_CONFIG_VALUE_2: 'v2', GIT_OBJECT_DIRECTORY: 'x' },
    '/empty-hooks',
  );
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_KEY_2', 'GIT_CONFIG_VALUE_2']) assert.equal(env[k], undefined, k);
  assert.equal(env.PATH, 'p');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.ok(Object.values(env).includes('/empty-hooks'));
});

test('XREVIEW #7: treeHash returns null when git add -A fails (untracked repo without commits inside the tree)', () => {
  const repo = new Repo();
  try {
    repo.write('a.js', 'v1\n');
    repo.commit('init');
    const inner = path.join(repo.dir, 'vendor', 'inner');
    fs.mkdirSync(inner, { recursive: true });
    run('git', ['init', '-q'], { cwd: inner, env: repo.env });
    fs.writeFileSync(path.join(inner, 'f'), 'x\n');
    run('git', ['add', 'f'], { cwd: inner, env: repo.env });
    repo.write('a.js', 'v2 edited\n');
    const head = git.git(['rev-parse', 'HEAD^{tree}'], { cwd: repo.dir, env: repo.env }).out.trim();
    const tree = git.treeHash(repo.dir, { env: repo.env });
    assert.notEqual(tree, head, 'must not return the stale pre-edit tree');
    assert.equal(tree, null);
  } finally {
    repo.cleanup();
  }
});

test('XREVIEW #7: a run whose snapshot failed is not recorded as a verify of some tree; mark says so', () => {
  const repo = new Repo();
  try {
    repo.write('a.js', 'v1\n');
    repo.commit('init');
    const inner = path.join(repo.dir, 'vendor', 'inner');
    fs.mkdirSync(inner, { recursive: true });
    run('git', ['init', '-q'], { cwd: inner, env: repo.env });
    fs.writeFileSync(path.join(inner, 'f'), 'x\n');
    run('git', ['add', 'f'], { cwd: inner, env: repo.env });
    repo.write('a.js', 'v2\n');
    const r = run(process.execPath, [VL, 'mark', 'verify', '--agent', 'claude'], { cwd: repo.dir, env: repo.env });
    assert.equal(r.status, 0);
    assert.match(r.stdout + r.stderr, /記録できませんでした|スナップショット/);
    assert.doesNotMatch(r.stdout, /記録しました/);
    assert.equal(repo.ledger().filter((x) => x.kind === 'run' && x.tree).length, 0);
    const h = repo.verify();
    assert.equal(h.status, 0);
    assert.equal(repo.ledger().filter((x) => x.kind === 'run' && x.tree).length, 0);
  } finally {
    repo.cleanup();
  }
});

test('XREVIEW #7: unreadable commit paths classify as unknown, not skipped', () => {
  const v = classify({ paths: null, run: { tree: 'abc' }, skipGlobs: ['*.md'], diffNames: () => new Set() });
  assert.equal(v.result, 'unknown');
});

test('XREVIEW #7: report counts unknown commits outside the verified-rate denominator', () => {
  const { summarize } = require('../scripts/lib/report');
  const rows = [
    { kind: 'commit', sha: 'a', result: 'verified' },
    { kind: 'commit', sha: 'b', result: 'unknown', n_files: null },
  ];
  const s = summarize(rows, ['a', 'b']);
  assert.equal(s.commits.unknown, 1);
  assert.equal(s.verified_rate_pct, 100);
});
