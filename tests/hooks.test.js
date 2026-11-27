'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Repo, run } = require('./helpers');

// Each test gets its own throw-away repo.
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

function seed(repo) {
  repo.write('src/a.js', 'one\n');
  repo.write('src/b.js', 'one\n');
  repo.commit('init');
}

t('verify then commit of verified content -> verified', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  assert.equal(repo.verify().status, 0);
  repo.commit('change');
  assert.equal(repo.commitHook().status, 0);
  const row = repo.lastCommitRow();
  assert.equal(row.result, 'verified');
  assert.equal(row.stale_files, 0);
  assert.equal(row.mode, 'observe');
  assert.equal(row.session_verify, true);
  assert.equal(row.session_code_review, false);
  assert.ok(row.since_run_s >= 0 && row.since_run_s < 60);
});

t('edit after verify -> stale with the number of differing committed files', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  repo.verify();
  repo.write('src/a.js', 'three\n');
  repo.write('src/b.js', 'two\n'); // never present at verify time as "two"
  repo.commit('change');
  repo.commitHook();
  const row = repo.lastCommitRow();
  assert.equal(row.result, 'stale');
  assert.equal(row.stale_files, 2);
});

t('no verify -> none', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  repo.commit('change');
  repo.commitHook();
  assert.equal(repo.lastCommitRow().result, 'none');
  assert.equal(repo.lastCommitRow().since_run_s, null);
});

t('docs/tests-only commit -> skipped (even without verify)', (repo) => {
  seed(repo);
  repo.write('README.md', 'x\n');
  repo.write('docs/guide.txt', 'x\n');
  repo.write('tests/a.test.js', 'x\n');
  repo.commit('docs');
  repo.commitHook();
  assert.equal(repo.lastCommitRow().result, 'skipped');
});

t('skipGlobs from config.json are honoured', (repo) => {
  seed(repo);
  repo.config({ skipGlobs: ['generated/**'] });
  repo.write('generated/x.js', 'x\n');
  repo.commit('gen');
  repo.commitHook();
  assert.equal(repo.lastCommitRow().result, 'skipped');
});

t('SKILL.md added after verify stays outside the fully verified commit', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  repo.verify();
  repo.write('.claude/skills/verify/SKILL.md', '---\nname: verify\n---\nrecipe\n'); // recorded by /verify itself
  repo.git('add', 'src/a.js');
  repo.git('commit', '-m', 'only the verified file');
  repo.commitHook();
  assert.equal(repo.lastCommitRow().result, 'verified');
  assert.equal(repo.lastCommitRow().worktree_tree_match, false);
  assert.equal(repo.lastCommitRow().paths_match, true);
  assert.equal(repo.lastCommitRow().stale_files, 0);
});

t('verified but uncommitted untracked content makes the commit tree stale', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  repo.write('scratch.tmp', 'junk\n');
  repo.verify();
  repo.write('scratch.tmp', 'other junk\n');
  repo.git('add', 'src/a.js');
  repo.git('commit', '-m', 'c');
  repo.commitHook();
  assert.equal(repo.lastCommitRow().result, 'stale');
  assert.equal(repo.lastCommitRow().paths_match, true);
});

t('root commit is judged against the verified tree', (repo) => {
  repo.write('src/a.js', 'one\n');
  repo.verify(); // no HEAD yet
  repo.commit('init');
  repo.commitHook();
  const row = repo.lastCommitRow();
  assert.equal(row.result, 'verified');
  assert.equal(row.n_files, 1);
});

t('verify run by the user (UserPromptExpansion) counts like a model run', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  repo.verify('user');
  repo.commit('c');
  repo.commitHook();
  assert.equal(repo.lastCommitRow().result, 'verified');
  const run = repo.ledger().find((r) => r.kind === 'run');
  assert.equal(run.via, 'user');
  assert.equal(run.skill, 'verify');
});

t('amend keeps the earlier verified run; "--amend" inside a quoted message is not an amend', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  repo.verify();
  repo.commit('c1');
  repo.commitHook();
  repo.git('commit', '--amend', '-m', 'reworded');
  repo.commitHook('git commit --amend -m reworded');
  assert.equal(repo.lastCommitRow().result, 'verified');

  repo.write('src/b.js', 'two\n');
  repo.commit('c2 about --amend');
  repo.commitHook(`git commit -m "talk about --amend"`);
  assert.equal(repo.lastCommitRow().result, 'none'); // earlier run belongs to the previous commit
});

t('merge commit is judged against its first parent', (repo) => {
  seed(repo);
  repo.git('checkout', '-q', '-b', 'feature');
  repo.write('src/f.js', 'f\n');
  repo.commit('feature');
  repo.git('checkout', '-q', 'main');
  repo.verify();
  repo.git('merge', '--no-ff', '--no-commit', '-q', 'feature');
  repo.git('commit', '-m', 'merge'); // `git commit` finishing the merge: reflog "commit (merge)"
  repo.commitHook();
  const row = repo.lastCommitRow();
  assert.equal(row.n_files, 1);
  assert.equal(row.result, 'stale'); // f.js was not part of the verified tree
});

t('detached HEAD works', (repo) => {
  seed(repo);
  repo.git('checkout', '-q', '--detach');
  repo.write('src/a.js', 'two\n');
  repo.verify();
  repo.commit('d');
  repo.commitHook();
  assert.equal(repo.lastCommitRow().result, 'verified');
});

t('linked worktree: ledger lives under the worktree git dir and hooks work', (repo) => {
  seed(repo);
  const wt = path.join(repo.home, 'wt');
  repo.git('worktree', 'add', '-q', wt, '-b', 'wtb');
  const wtEnv = repo.env;
  const g = (...a) => {
    const r = run('git', a, { cwd: wt, env: wtEnv });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  fs.writeFileSync(path.join(wt, 'src', 'a.js'), 'wt\n');
  repo.hook(['skill'], { tool_input: { skill: 'verify' } }, { cwd: wt });
  g('add', '-A');
  const stdout = g('commit', '-m', 'wt');
  const r = repo.hook(['commit'], { tool_input: { command: 'git commit -m wt' }, tool_response: { stdout } }, { cwd: wt });
  assert.equal(r.status, 0);
  const ledgerPath = path.resolve(wt, g('rev-parse', '--git-path', 'claude-verify'), 'ledger.jsonl');
  const rows = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.find((x) => x.kind === 'commit').result, 'verified');
});

t('chained shell command (git add -A && git commit && git push) is handled', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  repo.verify();
  repo.commit('c');
  repo.commitHook('git add -A && git commit -m c && git push origin main');
  assert.equal(repo.lastCommitRow().result, 'verified');
});

t('the same commit is recorded once; old commits are ignored', (repo) => {
  seed(repo);
  repo.commitHook();
  repo.commitHook();
  assert.equal(repo.ledger().filter((r) => r.kind === 'commit').length, 1);

  repo.write('src/a.js', 'old\n');
  repo.commit('old', { GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' });
  repo.commitHook();
  assert.equal(repo.ledger().filter((r) => r.kind === 'commit').length, 1);
});

t('session_verify / session_code_review are per session_id', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  repo.verify('model', 'A');
  repo.codeReview('A');
  repo.commit('c');
  repo.commitHook('git commit -m c', 'B');
  let row = repo.lastCommitRow();
  assert.equal(row.session_verify, false);
  assert.equal(row.session_code_review, false);
  assert.equal(row.result, 'verified'); // tree-based, independent of the session

  repo.write('src/b.js', 'two\n');
  repo.commit('d');
  repo.commitHook('git commit -m d', 'A');
  row = repo.lastCommitRow();
  assert.equal(row.session_verify, true);
  assert.equal(row.session_code_review, true);
});

t('mode off writes nothing', (repo) => {
  seed(repo);
  repo.config({ mode: 'off' });
  repo.verify();
  repo.commitHook();
  assert.deepEqual(repo.ledger(), []);
});

t('UserPromptExpansion names: nested verify, review alias, others ignored', (repo) => {
  seed(repo);
  const expand = (name) => repo.hook(['expand'], { hook_event_name: 'UserPromptExpansion', command_name: name, command_args: 'x', prompt: `/${name} x` });
  expand('apps/web:verify');
  expand('review');
  expand('code-review');
  expand('simplify');
  expand('myverify');
  const runs = repo.ledger().filter((r) => r.kind === 'run');
  assert.deepEqual(runs.map((r) => r.skill), ['verify', 'code-review', 'code-review']);
  assert.ok(runs.every((r) => r.via === 'user'));
});

t('the Skill hook records verify, nested verify and the review alias, and ignores other skills', (repo) => {
  seed(repo);
  const call = (skill, extra = {}) => repo.hook(['skill'], { tool_name: 'Skill', tool_input: { skill }, ...extra });
  for (const skill of ['verify', 'apps/web:verify', 'review', 'code-review', 'Verify']) call(skill);
  for (const skill of ['simplify', 'verify-all', 'reviewer', 'preview', '']) call(skill);
  repo.hook(['skill'], { tool_name: 'Skill', tool_input: {} });
  const runs = repo.ledger().filter((r) => r.kind === 'run');
  assert.deepEqual(runs.map((r) => r.skill), ['verify', 'verify', 'code-review', 'code-review', 'verify']);
  assert.ok(runs.every((r) => r.via === 'model'));
});

t('the Skill hook answers a non-matching skill with no output and no ledger', (repo) => {
  seed(repo);
  const r = repo.hook(['skill'], { tool_name: 'Skill', tool_input: { skill: 'simplify' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.deepEqual(repo.ledger(), []);
});

t('a hook in a directory that is not a git repo does nothing and exits 0', (repo) => {
  const r = repo.hook(['commit'], { tool_input: { command: 'git commit' } }, { cwd: repo.home });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// Regression (deterministic): the temp index is a copy of the real one. If the copy had a fresh
// mtime, git's racy-clean check would be defeated and a same-size edit made in the same second as
// the last index write would be missed, recording a stale tree for correctly verified work.
// core.checkStat=minimal makes git compare whole-second mtime and size only, so the stat data can
// be reproduced exactly with utimes; the entry is then "racy" only if the index mtime is preserved.
t('same-size edit in the same second as the index write is seen (racy-git regression)', (repo) => {
  repo.git('config', 'core.checkStat', 'minimal');
  repo.git('config', 'core.trustctime', 'false');
  seed(repo);
  // Move the cached stat of a.js (and the index mtime) well into the past so the test does not
  // depend on the wall clock: only the preserved index mtime can make the entry "racy".
  const past = Math.floor(Date.now() / 1000) - 1000;
  const file = path.join(repo.dir, 'src', 'a.js');
  fs.utimesSync(file, past, past);
  repo.git('update-index', '--refresh');
  fs.writeFileSync(file, 'two\n'); // same size as "one\n"
  fs.utimesSync(file, past, past); // identical stat to the cached entry
  fs.utimesSync(path.join(repo.dir, '.git', 'index'), past, past); // entry mtime == index mtime: racy
  repo.verify();
  repo.git('add', 'src/a.js');
  repo.git('commit', '-m', 'edit');
  repo.commitHook();
  assert.equal(repo.lastCommitRow().result, 'verified');
  // the recorded tree really contains the edited content
  const tree = repo.ledger().find((r) => r.kind === 'run').tree;
  assert.equal(repo.git('show', `${tree}:src/a.js`), 'two');
});
