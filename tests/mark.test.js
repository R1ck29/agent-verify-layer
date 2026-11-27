'use strict';
// `vl.js mark verify`: records the tree at the moment the checks passed (RESULTS.md, next version 1 and 4).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Repo, VL, run } = require('./helpers');

function t(name, fn) {
  test(name, async () => {
    const repo = new Repo();
    try {
      await fn(repo);
    } finally {
      repo.cleanup();
    }
  });
}

function mark(repo, args = ['--agent', 'claude'], { cwd, env } = {}) {
  return run(process.execPath, [VL, 'mark', 'verify', ...args], { cwd: cwd || repo.dir, env: { ...repo.env, ...env } });
}

function seed(repo) {
  repo.write('src/a.js', 'one\n');
  repo.commit('init');
}

// The false stale seen in SMOKE.md (2nd run) and 2/16 E1 trials: verify loaded before the edit,
// the check run after it. With mark after the check, the commit is judged against the checked tree.
t('verify loaded before the edit, mark after the check -> verified (basis mark)', (repo) => {
  seed(repo);
  repo.verify(); // Skill(verify) read before editing: tree = HEAD
  repo.write('src/a.js', 'two\n'); // the edit
  const r = mark(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /確認した時点の状態を記録しました/);
  repo.commit('change');
  repo.commitHook();
  const row = repo.lastCommitRow();
  assert.equal(row.result, 'verified');
  assert.equal(row.basis, 'mark');
  assert.equal(row.agent, 'claude');
});

t('without mark the same sequence stays stale (v0.1 judgement unchanged)', (repo) => {
  seed(repo);
  repo.verify();
  repo.write('src/a.js', 'two\n');
  repo.commit('change');
  repo.commitHook();
  const row = repo.lastCommitRow();
  assert.equal(row.result, 'stale');
  assert.equal(row.basis, 'model');
});

t('an edit after mark -> stale', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  mark(repo);
  repo.write('src/a.js', 'three\n');
  repo.commit('change');
  repo.commitHook();
  const row = repo.lastCommitRow();
  assert.equal(row.result, 'stale');
  assert.equal(row.stale_files, 1);
  assert.equal(row.basis, 'mark');
});

t('mark row shape: a verify run via mark with the current tree, agent and session from the env', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  mark(repo, ['--agent', 'codex'], { env: { CODEX_THREAD_ID: 'thread-9' } });
  const row = repo.ledger().pop();
  assert.equal(row.kind, 'run');
  assert.equal(row.skill, 'verify');
  assert.equal(row.via, 'mark');
  assert.equal(row.agent, 'codex');
  assert.equal(row.session, 'thread-9');
  assert.match(row.tree, /^[0-9a-f]{40}$/);
  assert.equal(repo.git('cat-file', '-t', row.tree), 'tree');
  // Claude: the session comes from CLAUDE_CODE_SESSION_ID (same value as the hook session_id),
  // so session_verify is true for a commit in that session.
  mark(repo, [], { env: { CLAUDE_CODE_SESSION_ID: repo.sessionId } });
  const c = repo.ledger().pop();
  assert.equal(c.agent, 'claude');
  assert.equal(c.session, repo.sessionId);
  repo.commit('c');
  repo.commitHook();
  assert.equal(repo.lastCommitRow().session_verify, true);
});

t('mark prints the checklist items that match the diff at check time', (repo) => {
  repo.write('.claude/verification/checklist.json', JSON.stringify({ items: [{ id: 'stderr-notice', paths: ['src/**'], pattern: 'console\\.error', check: 'stdout?', why: 'w', owner: 'o' }] }));
  seed(repo);
  repo.write('src/a.js', 'console.error(1)\n');
  const r = mark(repo);
  assert.match(r.stdout, /\[stderr-notice\]/);
  assert.match(r.stdout, /コミットの前に確認してください/);
  assert.deepEqual(repo.ledger().pop().fired, ['stderr-notice']);
});

t('mark never fails the caller: outside a repo, mode=off, bad usage', (repo) => {
  let r = mark(repo, [], { cwd: repo.home });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /git リポジトリではない/);
  seed(repo);
  repo.config({ mode: 'off' });
  r = mark(repo);
  assert.equal(r.status, 0);
  assert.deepEqual(repo.ledger(), []);
  r = run(process.execPath, [VL, 'mark'], { cwd: repo.dir, env: repo.env });
  assert.equal(r.status, 2);
  r = run(process.execPath, [VL, 'mark', 'verify', '--agent', 'gpt'], { cwd: repo.dir, env: repo.env });
  assert.equal(r.status, 2);
});

t('a read-only ledger location is reported, exit 0', (repo) => {
  seed(repo);
  const dir = path.dirname(repo.ledgerFile());
  fs.writeFileSync(dir, 'not a dir'); // .git/claude-verify is a file: append fails
  const r = mark(repo);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /書き込めませんでした/);
});

t('the verify Skill hook hands the mark command; markHint:false removes it', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  const text = repo.verify().json.hookSpecificOutput.additionalContext;
  assert.ok(text.includes(`node "${VL}" mark verify --agent claude`), text);
  repo.config({ markHint: false });
  assert.equal(repo.verify().stdout, '');
});

t('report counts mark rows separately from verify starts', (repo) => {
  seed(repo);
  repo.verify();
  repo.write('src/a.js', 'two\n');
  mark(repo);
  repo.commit('c');
  repo.commitHook();
  const r = run(process.execPath, [VL, 'report', '--json'], { cwd: repo.dir, env: repo.env });
  const j = JSON.parse(r.stdout);
  assert.equal(j.runs.verify, 1);
  assert.equal(j.runs.verify_marked, 1);
  assert.equal(j.commits.verified, 1);
});
