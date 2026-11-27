'use strict';
// XREVIEW #6 (only a commit the command really made is recorded), #8 (verified = the full commit
// tree matching the recorded verification tree), #9 (concurrent hooks
// record a SHA once), and consecutive amends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Repo, VL, run } = require('./helpers');
const { classify } = require('../scripts/lib/classify');
const { analyzeCommit } = require('../scripts/lib/commitcmd');
const git = require('../scripts/lib/git');
const ledger = require('../scripts/lib/ledger');
const { handleCommit } = require('../scripts/lib/hooks');

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
t('XREVIEW r2 #6: skipped shell branches and notifications without commit output stay uncaptured', (repo) => {
  repo.write('a.js', 'one\n');
  repo.commit('manual');
  for (const [command, stdout] of [
    ['true || git commit -m x', repo.commitOutput],
    ['false && git commit -m x; true', repo.commitOutput],
    ['git commit -m x; true', ''],
    ['git commit -m x', ''],
  ]) {
    const r = repo.hook(['commit'], { tool_input: { command }, tool_response: { exit_code: 0, stdout } });
    assert.equal(r.status, 0);
    assert.equal(commitRows(repo).length, 0, command);
  }
});

t('XREVIEW r2 #6: commit output is matched in the tool workdir, not the top-level cwd', (repo) => {
  repo.write('a.js', 'outer\n');
  repo.commit('outer');
  const other = new Repo();
  try {
    other.write('a.js', 'inner\n');
    other.git('add', 'a.js');
    const stdout = other.git('commit', '-m', 'inner');
    const result = repo.hook(['commit', '--agent', 'codex'], {
      tool_input: { command: 'git commit -m inner', workdir: other.dir },
      tool_response: { exit_code: 0, output: stdout },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(commitRows(repo), []);
    assert.deepEqual(commitRows(other).map((r) => r.sha), [other.git('rev-parse', 'HEAD')]);
  } finally {
    other.cleanup();
  }
});

t('XREVIEW r2 #6: a notification for a different SHA cannot claim the latest commit', (repo) => {
  repo.write('a.js', 'one\n');
  repo.commit('first');
  const firstOutput = repo.commitOutput;
  repo.write('a.js', 'two\n');
  const second = repo.commit('second');
  const input = { tool_input: { command: 'git commit -m first' } };
  const notify = (tool_response) => repo.hook(['commit'], { ...input, tool_response });
  assert.equal(notify({ stdout: firstOutput }).status, 0);
  assert.deepEqual(commitRows(repo), []);
  assert.equal(notify({ stdout: firstOutput + repo.commitOutput }).status, 0);
  assert.deepEqual(commitRows(repo), []);
  assert.equal(notify(`Process exited with code 0\nFinal output:\n${repo.commitOutput}`).status, 0);
  assert.deepEqual(commitRows(repo).map((row) => row.sha), [second]);
});

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
    repo.hook(['commit'], { tool_input: { command: `git -C ${JSON.stringify(other.dir)} commit -m other` }, tool_response: { stdout: other.commitOutput } });
    assert.equal(commitRows(repo).length, 0);
    assert.equal(commitRows(other).length, 1, 'the commit is recorded in the repository it was made in');
    const r = repo.hook(['commit'], { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `cd ${JSON.stringify(other.dir)} && git commit -m other` }, tool_response: { stdout: other.commitOutput } });
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
  const stdout = repo.commitOutput;
  for (const tool_response of [{ exit_code: 1, stdout }, JSON.stringify({ exit_code: 1, stdout }), { is_error: true, stdout }, { success: false, stdout }]) {
    const r = repo.hook(['commit', '--agent', 'codex'], { hook_event_name: 'PostToolUse', tool_name: 'Bash', turn_id: 't', tool_input: { command: 'git commit -m x' }, tool_response });
    assert.equal(r.status, 0);
  }
  assert.equal(commitRows(repo).length, 0);
  const ok = repo.hook(['commit', '--agent', 'codex'], { hook_event_name: 'PostToolUse', tool_name: 'Bash', turn_id: 't', tool_input: { command: 'git commit -m manual' }, tool_response: { exit_code: 0, output: repo.commitOutput } });
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
  assert.equal(analyzeCommit('true || git commit -m x', w, true), null);
  assert.equal(analyzeCommit('false && git commit -m x; true', w, true), null);
  assert.deepEqual(analyzeCommit('false || git commit -m x', w, true), { dir: w });
  assert.equal(a('cd sub; git commit -m x').unsupported, true);
  assert.equal(a('git commit -m x; git commit -m y').unsupported, true);
});

test('XREVIEW r2 #6: a conditional literal cannot settle an unknown preceding Git status', () => {
  for (const literal of ['true', ':']) {
    const command = `git status --invalid-option && ${literal} || false && git commit -m x`;
    assert.deepEqual(analyzeCommit(command, path.resolve('/w'), true), { unsupported: true });
  }
});

test('analyzeCommit keeps Windows backslashes in paths (win32 reading) and unescapes them for POSIX', { skip: process.platform === 'win32' }, () => {
  assert.ok(analyzeCommit('git -C C:\\repo\\sub commit -m x', '/w', false).dir.endsWith('C:\\repo\\sub'));
  assert.ok(analyzeCommit('git -C "C:\\repo\\sub" commit -m x', '/w', false).dir.endsWith('C:\\repo\\sub'));
  assert.ok(analyzeCommit('git -C C:\\repo\\sub commit -m x', '/w', true).dir.endsWith('C:reposub'));
});

// --- #8 -----------------------------------------------------------------------------------------
t('XREVIEW #8: an edit left out of a full verified commit changes only the worktree comparison', (repo) => {
  repo.write('src/a.js', 'one\n');
  repo.write('src/b.js', 'one\n');
  repo.commit('init');
  repo.write('src/a.js', 'two\n');
  repo.verify();
  repo.write('src/b.js', 'edited after verify\n'); // not part of the commit
  repo.git('add', 'src/a.js');
  repo.git('commit', '-m', 'a only');
  repo.commitHook();
  const row = repo.lastCommitRow();
  assert.equal(row.result, 'verified');
  assert.equal(row.worktree_tree_match, false);
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
  repo.git('commit', '-m', 'app only');
  repo.commitHook();
  const row = repo.lastCommitRow();
  assert.equal(row.result, 'stale');
  assert.equal(row.worktree_tree_match, true);
  assert.equal(row.head_tree_match, false, 'the committed combination was never run');
  const { summarize } = require('../scripts/lib/report');
  assert.equal(summarize(repo.ledger(), []).verified_head_exact, 0);
  assert.equal(summarize(repo.ledger(), []).verified_rate_pct, 0);
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
  assert.deepEqual([partial.result, partial.head_tree_match, partial.worktree_tree_match], ['stale', false, true]);
  assert.equal(classify({ ...base, run: { tree: 'T' }, worktreeTree: null, headTree: 'T' }).result, 'verified');
  const s = classify({ ...base, run: { tree: 'T' }, worktreeTree: 'W', headTree: 'H' });
  assert.deepEqual([s.result, s.paths_match, s.stale_files], ['stale', true, 0]);
  const s2 = classify({ ...base, run: { tree: 'T' }, worktreeTree: 'W', headTree: 'H', diffNames: () => new Set(['a.js']) });
  assert.deepEqual([s2.result, s2.paths_match, s2.stale_files], ['stale', false, 1]);
  assert.equal(classify({ ...base, run: { tree: 'T' }, worktreeTree: 'T', headTree: null }).result, 'unknown');
  assert.equal(classify({ ...base, run: null, worktreeTree: 'W', headTree: 'H' }).result, 'none');
});

test('XREVIEW r2 HIGH 1: a moving HEAD cannot change the captured commit paths, tree or diff', (context) => {
  const repo = new Repo();
  try {
    repo.write('app.js', 'verified\n');
    repo.verify();
    repo.write('app.js', 'changed\n');
    repo.git('add', '-A');
    const stdout = repo.git('commit', '-m', 'first');
    const first = repo.git('rev-parse', 'HEAD');
    const reflog = git.reflog;
    context.mock.method(git, 'reflog', (...args) => {
      const rows = reflog(...args);
      repo.write('app.js', 'verified\n');
      repo.write('.claude/skills/verify/SKILL.md', 'another commit\n');
      repo.commit('second');
      return rows;
    });
    handleCommit({ ...commitInput(repo), tool_response: { stdout } });
    const row = repo.lastCommitRow();
    assert.deepEqual([row.sha, row.n_files, row.self_check_change, row.stale_files, row.paths_match, row.head_tree_match], [first, 1, false, 1, false, false]);
  } finally {
    repo.cleanup();
  }
});

test('XREVIEW r2 HIGH 2: mark appended during commit capture cannot justify that commit', (context) => {
  const repo = new Repo();
  try {
    repo.write('app.js', 'one\n');
    repo.git('add', '-A');
    const stdout = repo.git('commit', '-m', 'first');
    const tree = repo.git('rev-parse', 'HEAD^{tree}');
    const withLock = ledger.withLock;
    context.mock.method(ledger, 'withLock', (root, fn) => {
      ledger.append(root, { kind: 'run', ts: Date.now() / 1000 + 1, skill: 'verify', via: 'mark', tree, session: 's' });
      return withLock(root, fn);
    });
    handleCommit({ ...commitInput(repo), tool_response: { stdout } });
    const row = repo.lastCommitRow();
    assert.deepEqual([row.result, row.basis, row.since_run_s, row.session_verify], ['none', null, null, false]);
  } finally {
    repo.cleanup();
  }
});

t('XREVIEW r2 HIGH 2: a mark made after committing and before the hook is ineligible', (repo) => {
  repo.write('app.js', 'one\n');
  repo.git('add', '-A');
  const stdout = repo.git('commit', '-m', 'first');
  const mark = run(process.execPath, [VL, 'mark', 'verify'], { cwd: repo.dir, env: repo.env });
  assert.equal(mark.status, 0, mark.stderr);
  assert.equal(repo.ledger()[0].via, 'mark');
  const result = repo.hook(['commit'], { ...commitInput(repo), tool_response: { stdout } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.lastCommitRow().result, 'none');
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
const commitInput = (repo) => ({ session_id: 's', cwd: repo.dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m init' }, tool_response: { stdout: repo.commitOutput } });

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
    repo.git('commit', '--amend', '-m', msg);
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
