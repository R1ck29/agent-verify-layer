'use strict';
// XREVIEW #6 (only a commit the command really made is recorded), #8 (verified = the working tree
// hash of the design source; the committed-files view is a separate figure), #9 (concurrent hooks
// record a SHA once), and consecutive amends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Repo, VL } = require('./helpers');
const { classify } = require('../scripts/lib/classify');
const { analyzeCommit } = require('../scripts/lib/commitcmd');

function t(name, fn, opts = {}) {
  test(name, opts, async () => {
    const repo = new Repo();
    try {
      await fn(repo);
    } finally {
      repo.cleanup();
    }
  });
}
const commitRows = (repo) => repo.ledger().filter((r) => r.kind === 'commit');

// --- #6 -----------------------------------------------------------------------------------------
t('XREVIEW #6: read-only git commands that merely contain the word commit never record the recent HEAD', (repo) => {
  repo.write('src/a.js', 'one\n');
  repo.commit('init'); // a fresh, unrecorded commit (made outside any recorded command)
  for (const command of ['git log -1 --format=%s --grep=commit', 'git show HEAD --stat # commit', 'git commit --dry-run', 'git commit -n --dry-run -m x', 'echo git commit', 'git status && echo "commit"']) {
    for (const agent of ['claude', 'codex']) {
      const r = repo.hook(['commit', ...(agent === 'codex' ? ['--agent', 'codex'] : [])], { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: {}, ...(agent === 'codex' ? { turn_id: 't' } : {}) });
      assert.equal(r.status, 0);
    }
  }
  assert.equal(commitRows(repo).length, 0);
  repo.commitHook('git commit -m init'); // the real thing is still recorded
  assert.equal(commitRows(repo).length, 1);
});

t('XREVIEW #6: -C and cd select the repository that was committed in; a commit elsewhere is not attributed to cwd', (repo) => {
  repo.write('src/a.js', 'one\n');
  repo.commit('init');
  const other = new Repo();
  try {
    other.write('x.js', '1\n');
    other.commit('other init');
    // cwd repo has a fresh unrecorded commit, but the command committed in `other`
    repo.commitHook(`git -C ${JSON.stringify(other.dir)} commit -m other`);
    assert.equal(commitRows(repo).length, 0);
    assert.equal(commitRows(other).length, 1, 'the commit is recorded in the repository it was made in');
    const r = repo.hook(['commit'], { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `cd ${JSON.stringify(other.dir)} && git commit -m other` }, tool_response: {} });
    assert.equal(r.status, 0);
    assert.equal(commitRows(other).length, 1, 'recorded once');
    assert.equal(commitRows(repo).length, 0);
  } finally {
    other.cleanup();
  }
});

t('XREVIEW #6: a command that reports failure never takes over an older unrecorded commit', (repo) => {
  repo.write('src/a.js', 'one\n');
  repo.commit('manual'); // recent, unrecorded
  for (const tool_response of [{ exit_code: 1 }, '{"exit_code":1}', { is_error: true }, { success: false }]) {
    const r = repo.hook(['commit', '--agent', 'codex'], { hook_event_name: 'PostToolUse', tool_name: 'Bash', turn_id: 't', tool_input: { command: 'git commit -m x' }, tool_response });
    assert.equal(r.status, 0);
  }
  assert.equal(commitRows(repo).length, 0);
  const ok = repo.hook(['commit', '--agent', 'codex'], { hook_event_name: 'PostToolUse', tool_name: 'Bash', turn_id: 't', tool_input: { command: 'git commit -m x' }, tool_response: { exit_code: 0 } });
  assert.equal(ok.status, 0);
  assert.equal(commitRows(repo).length, 1);
});

test('XREVIEW #6: analyzeCommit reads real commit invocations and refuses what it cannot place', () => {
  const w = path.resolve('/w'); // C:\w on Windows
  const a = (c) => analyzeCommit(c, w);
  assert.deepEqual(a('git commit -m x'), { dir: w });
  assert.deepEqual(a('git add -A && git commit -m "x && y"'), { dir: w });
  assert.deepEqual(a('cd sub && git commit -m x'), { dir: path.resolve(w, 'sub') });
  assert.deepEqual(a('git -C ../o -c user.name=x commit -m x'), { dir: path.resolve(w, '../o') });
  assert.deepEqual(a('FOO=1 git --no-pager commit --amend'), { dir: w });
  assert.equal(a('git commit --dry-run'), null);
  assert.equal(a('git log --grep=commit'), null);
  assert.equal(a('git commit-tree abc'), null);
  assert.equal(a('echo git commit'), null);
  assert.equal(a('git --git-dir=/x/.git commit -m x').unsupported, true);
  assert.equal(a('GIT_DIR=/x git commit -m x').unsupported, true);
  assert.equal(a('cd "$REPO" && git commit -m x').unsupported, true);
});

test('analyzeCommit keeps Windows backslashes in paths (win32 reading) and unescapes them for POSIX', { skip: process.platform === 'win32' }, () => {
  assert.ok(analyzeCommit('git -C C:\\repo\\sub commit -m x', '/w', false).dir.endsWith('C:\\repo\\sub'));
  assert.ok(analyzeCommit('git -C "C:\\repo\\sub" commit -m x', '/w', false).dir.endsWith('C:\\repo\\sub'));
  assert.ok(analyzeCommit('git -C C:\\repo\\sub commit -m x', '/w', true).dir.endsWith('C:reposub'));
});

// --- #8 -----------------------------------------------------------------------------------------
t('XREVIEW #8: verified needs the working-tree hash of the verify run; a committed-files-only match is stale with paths_match', (repo) => {
  repo.write('src/a.js', 'one\n');
  repo.write('src/b.js', 'one\n');
  repo.commit('init');
  repo.write('src/a.js', 'two\n');
  repo.verify();
  repo.write('src/b.js', 'edited after verify\n'); // not part of the commit
  repo.git('add', 'src/a.js');
  repo.git('commit', '-q', '-m', 'a only');
  repo.commitHook();
  const row = repo.lastCommitRow();
  assert.equal(row.result, 'stale');
  assert.equal(row.paths_match, true);
  assert.equal(row.stale_files, 0);
});

t('XREVIEW #8: partial commit of mutually dependent changes records head_tree_match=false', (repo) => {
  repo.write('app.js', 'require("./helper")\n');
  repo.write('helper.js', 'v1\n');
  repo.commit('init');
  repo.write('app.js', 'require("./helper"); // uses v2\n');
  repo.write('helper.js', 'v2\n');
  repo.verify();
  repo.git('add', 'app.js');
  repo.git('commit', '-q', '-m', 'app only');
  repo.commitHook();
  const row = repo.lastCommitRow();
  assert.equal(row.head_tree_match, false, 'the committed combination was never run');
  const { summarize } = require('../scripts/lib/report');
  assert.equal(summarize(repo.ledger(), []).verified_head_exact, 0);
});

t('XREVIEW #8: a full commit of the verified tree has head_tree_match=true', (repo) => {
  repo.write('app.js', 'one\n');
  repo.commit('init');
  repo.write('app.js', 'two\n');
  repo.verify();
  repo.commit('all');
  repo.commitHook();
  const row = repo.lastCommitRow();
  assert.equal(row.result, 'verified');
  assert.equal(row.head_tree_match, true);
});

test('XREVIEW #8: classify', () => {
  const base = { paths: ['a.js'], skipGlobs: [], diffNames: () => new Set() };
  assert.equal(classify({ ...base, run: { tree: 'T' }, worktreeTree: 'T', headTree: 'T' }).result, 'verified');
  const partial = classify({ ...base, run: { tree: 'T' }, worktreeTree: 'T', headTree: 'H' });
  assert.deepEqual([partial.result, partial.head_tree_match], ['verified', false]);
  const s = classify({ ...base, run: { tree: 'T' }, worktreeTree: 'W', headTree: 'H' });
  assert.deepEqual([s.result, s.paths_match, s.stale_files], ['stale', true, 0]);
  const s2 = classify({ ...base, run: { tree: 'T' }, worktreeTree: 'W', headTree: 'H', diffNames: () => new Set(['a.js']) });
  assert.deepEqual([s2.result, s2.paths_match, s2.stale_files], ['stale', false, 1]);
  assert.equal(classify({ ...base, run: { tree: 'T' }, worktreeTree: null, headTree: 'H' }).result, 'unknown');
  assert.equal(classify({ ...base, run: null, worktreeTree: 'W', headTree: 'H' }).result, 'none');
});

// --- #9 -----------------------------------------------------------------------------------------
function spawnHook(repo, input, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [VL, 'hook', 'commit'], { cwd: repo.dir, env: { ...repo.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, err }));
    p.stdin.end(JSON.stringify(input));
  });
}
const commitInput = (repo) => ({ session_id: 's', cwd: repo.dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m init' }, tool_response: {} });

t('XREVIEW #9: six concurrent hooks for one commit write one row', async (repo) => {
  repo.write('src/a.js', 'one\n');
  repo.commit('init');
  const results = await Promise.all(Array.from({ length: 6 }, () => spawnHook(repo, commitInput(repo))));
  assert.deepEqual(results.map((r) => r.code), [0, 0, 0, 0, 0, 0]);
  assert.equal(commitRows(repo).length, 1);
  assert.equal(fs.existsSync(path.join(path.dirname(repo.ledgerFile()), 'ledger.lock')), false, 'lock is released');
});

t('XREVIEW #9: a lock held by someone else never blocks the commit: bounded wait, exit 0, no duplicate row', async (repo) => {
  repo.write('src/a.js', 'one\n');
  repo.commit('init');
  fs.mkdirSync(path.join(path.dirname(repo.ledgerFile()), 'ledger.lock'), { recursive: true });
  const t0 = Date.now();
  const r = await spawnHook(repo, commitInput(repo), { VL_LOCK_WAIT_MS: '300' });
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(commitRows(repo).length, 0);
});

t('XREVIEW #9: an old lock with no known owner is left in place', async (repo) => {
  repo.write('src/a.js', 'one\n');
  repo.commit('init');
  const lock = path.join(path.dirname(repo.ledgerFile()), 'ledger.lock');
  fs.mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);
  const r = await spawnHook(repo, commitInput(repo), { VL_LOCK_WAIT_MS: '300' });
  assert.equal(r.code, 0);
  assert.equal(commitRows(repo).length, 0);
  assert.equal(fs.existsSync(lock), true);
});

// --- consecutive amend ----------------------------------------------------------------------------
t('consecutive message-only amends of a verified commit stay verified (linked by SHA, not by row position)', (repo) => {
  repo.write('src/a.js', 'one\n');
  repo.commit('init');
  repo.write('src/a.js', 'two\n');
  repo.verify();
  repo.commit('c1');
  repo.commitHook();
  for (const msg of ['reworded 1', 'reworded 2', 'reworded 3']) {
    repo.git('commit', '-q', '--amend', '-m', msg);
    repo.commitHook(`git commit --amend -m ${JSON.stringify(msg)}`);
  }
  assert.deepEqual(commitRows(repo).map((r) => r.result), ['verified', 'verified', 'verified', 'verified']);
});

t('a commit on another branch does not move the boundary: the run is found through the parent commit', (repo) => {
  repo.write('src/a.js', 'one\n');
  repo.commit('init');
  repo.commitHook();
  repo.git('checkout', '-q', '-b', 'feature');
  repo.write('src/a.js', 'f\n');
  repo.commit('on feature');
  repo.commitHook();
  repo.git('checkout', '-q', 'main');
  repo.write('src/b.js', 'm\n');
  repo.verify();
  repo.commit('on main');
  repo.commitHook();
  assert.equal(repo.lastCommitRow().result, 'verified');
});
