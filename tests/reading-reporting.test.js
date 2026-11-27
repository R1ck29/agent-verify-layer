'use strict';
// XREVIEW #10 (paths with spaces), #11 (config read the same way everywhere), #12 (report period
// and mark-route counts), plus the checklist symlink/warning and Codex project-config suggestions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Repo, VL, run, fakeCodex } = require('./helpers');
const { summarize } = require('../scripts/lib/report');
const { loadConfig } = require('../scripts/lib/config');
const checklist = require('../scripts/lib/checklist');

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
const ITEM = { id: 'no-eval', paths: ['**/*.js'], pattern: 'eval\\(', check: 'Is eval needed?', why: 'injection', owner: 'sec' };
const context = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;
const seed = (repo, items = [ITEM]) => {
  repo.write('.claude/verification/checklist.json', JSON.stringify({ version: 1, items }));
  repo.write('two words.js', 'ok();\n');
  repo.write('plain.js', 'ok();\n');
  repo.commit('init');
};

// --- #10 ----------------------------------------------------------------------------------------
t('XREVIEW #10: an added line in a tracked file whose name has spaces fires the pattern item', (repo) => {
  seed(repo);
  repo.write('two words.js', 'ok();\neval(x);\n');
  const r = repo.verify();
  assert.match(context(r), /\[no-eval\]/);
  assert.deepEqual(repo.ledger().find((x) => x.kind === 'run').fired, ['no-eval']);
});

t('XREVIEW #10: names with a trailing space, quotes and unicode are matched too', (repo) => {
  seed(repo);
  const names = ['trail .js', 'ünï cödé.js', "o'neil.js", ...(process.platform === 'win32' ? [] : ['q"uote.js'])]; // no " in Windows names
  for (const n of names) repo.write(n, 'ok();\n');
  repo.commit('more');
  for (const n of names) repo.write(n, 'ok();\neval(y);\n');
  const r = repo.verify();
  assert.match(context(r), /\[no-eval\]/);
  const fired = repo.ledger().find((x) => x.kind === 'run').fired;
  assert.deepEqual(fired, ['no-eval']);
  // every one of the files is individually a hit: remove the other edits and check each alone
  for (const n of names) {
    repo.git('checkout', '--', '.');
    repo.write(n, 'ok();\neval(y);\n');
    assert.match(context(repo.verify()), /\[no-eval\]/, n);
  }
});

t('an added line whose text begins with "++ " is content, not a diff header', (repo) => {
  seed(repo);
  repo.write('two words.js', 'ok();\n++ eval(x)\n');
  assert.match(context(repo.verify()), /\[no-eval\]/);
});

test('XREVIEW #10: parseAddedLines still parses a plain diff', () => {
  const m = checklist.parseAddedLines('--- a/x.js\n+++ b/x.js\n@@ -1 +1,2 @@\n ok\n+eval(1)\n');
  assert.deepEqual(m.get('x.js'), ['eval(1)']);
});

// --- checklist: symlinks and the warning --------------------------------------------------------
t('an untracked symlink is not followed when matching patterns (outside content is not read)', (repo) => {
  seed(repo);
  const outside = path.join(repo.home, 'outside.js');
  fs.writeFileSync(outside, 'eval(secret);\n');
  try {
    fs.symlinkSync(outside, path.join(repo.dir, 'link.js'));
  } catch {
    return; // symlinks not permitted here
  }
  const r = repo.verify();
  assert.doesNotMatch(context(r) || '', /\[no-eval\]/);
});

t('the self-check warning survives truncation of a long context', (repo) => {
  const items = Array.from({ length: 10 }, (_, i) => ({ ...ITEM, id: `item-${i}`, check: 'c'.repeat(900), why: 'w'.repeat(900) }));
  seed(repo, items);
  repo.write('two words.js', 'ok();\neval(x);\n');
  repo.write('CLAUDE.md', 'changed rules\n'); // touches the checks
  const text = context(repo.verify());
  assert.ok(text.length <= 8400, String(text.length)); // 8000 for the checklist text + the one-line mark hint
  assert.match(text.split('\n')[0], /チェック自体/, 'the warning comes first');
});

// --- #11 ----------------------------------------------------------------------------------------
t('XREVIEW #11: a config.json with a UTF-8 BOM and mode off is off for hook, mark and loadConfig', (repo) => {
  seed(repo);
  fs.mkdirSync(repo.env.VL_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(repo.env.VL_CONFIG_DIR, 'config.json'), '﻿{"mode":"off"}\n');
  const old = process.env.VL_CONFIG_DIR;
  process.env.VL_CONFIG_DIR = repo.env.VL_CONFIG_DIR;
  try {
    assert.equal(loadConfig().mode, 'off');
  } finally {
    if (old === undefined) delete process.env.VL_CONFIG_DIR;
    else process.env.VL_CONFIG_DIR = old;
  }
  repo.write('two words.js', 'ok();\nx;\n');
  assert.equal(repo.verify().status, 0);
  const m = run(process.execPath, [VL, 'mark', 'verify', '--agent', 'claude'], { cwd: repo.dir, env: repo.env });
  assert.equal(m.status, 0);
  assert.match(m.stdout, /mode=off/);
  repo.commit('c');
  repo.commitHook();
  assert.equal(repo.ledger().length, 0);
});

// --- #12 ----------------------------------------------------------------------------------------
function runReport(repo, args = []) {
  const r = run(process.execPath, [VL, 'report', '--json', ...args], { cwd: repo.dir, env: repo.env });
  return JSON.parse(r.stdout);
}

t('XREVIEW #12: --days counts git log from the period start even when the ledger is empty', (repo) => {
  repo.write('a.js', '1\n');
  repo.commit('one');
  repo.write('a.js', '2\n');
  repo.commit('two');
  const rep = runReport(repo, ['--days', '30']);
  assert.equal(rep.reconcile.git_log_commits, 2);
  assert.equal(rep.reconcile.not_recorded, 2);
  assert.equal(rep.reconcile.capture_rate_pct, 0);
});

t('XREVIEW #12: --days counts commits from before the first ledger row as not recorded', (repo) => {
  repo.write('a.js', '1\n');
  repo.commit('early, never recorded');
  repo.write('a.js', '2\n');
  repo.commit('recorded');
  repo.commitHook();
  const rep = runReport(repo, ['--days', '30']);
  assert.equal(rep.reconcile.git_log_commits, 2);
  assert.equal(rep.reconcile.recorded_in_log, 1);
  assert.equal(rep.reconcile.not_recorded, 1);
});

test('XREVIEW #12: checklist items shown at mark time (the only route on Codex) are counted per route', () => {
  const rows = [
    { kind: 'run', skill: 'verify', via: 'mark', agent: 'codex', ts: 1, fired: ['a', 'b'] },
    { kind: 'run', skill: 'verify', via: 'model', agent: 'claude', ts: 2, fired: ['a'], session: 's1', tree: 'same-tree' },
    { kind: 'run', skill: 'verify', via: 'mark', agent: 'claude', ts: 3, fired: ['a'], session: 's1', tree: 'same-tree' },
    { kind: 'run', skill: 'verify', via: 'mark', agent: 'claude', ts: 4, fired: ['a'], session: 's1', tree: 'other-tree' },
  ];
  const s = summarize(rows, []);
  assert.deepEqual(s.checklist_fired, { a: 3, b: 1 });
  assert.deepEqual(s.checklist_fired_by_route, { hook: { a: 1 }, mark: { a: 3, b: 1 } });
});

t('XREVIEW report: unavailable git log is distinct from successfully reading zero commits', (repo) => {
  repo.write('src/a.js', 'one\n');
  const date = '2000-01-01T12:00:00Z';
  repo.commit('old', { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const available = runReport(repo, ['--days', '1']);
  assert.equal(available.reconcile.git_log_commits, 0);
  assert.equal(available.reconcile.not_recorded, 0);

  const emptyObjects = path.join(repo.home, 'empty-objects');
  fs.mkdirSync(emptyObjects);
  const env = { ...repo.env, GIT_OBJECT_DIRECTORY: emptyObjects };
  const json = run(process.execPath, [VL, 'report', '--json'], { cwd: repo.dir, env });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).reconcile, {
    git_log_commits: null, recorded_in_log: null, not_recorded: null,
    capture_rate_pct: null, recorded_not_in_log: null,
  });
  const text = run(process.execPath, [VL, 'report'], { cwd: repo.dir, env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /git log.*取得不能/);
});

test('XREVIEW #8: report counts working-tree matches independently of verified commits', () => {
  const rows = [
    { kind: 'commit', result: 'stale', worktree_tree_match: true },
    { kind: 'commit', result: 'verified', head_tree_match: true, worktree_tree_match: false },
    { kind: 'commit', result: 'verified', head_tree_match: true, worktree_tree_match: null },
  ];
  const s = summarize(rows, []);
  assert.equal(s.worktree_tree_match, 1);
  assert.equal(s.commits.verified, 2);
});

test('XREVIEW #8: prior verified rows with a known different commit tree count as stale', () => {
  const rows = [
    { kind: 'commit', sha: 'a', result: 'verified', basis: 'mark', head_tree_match: false, stale_files: 0, paths_match: true },
    { kind: 'commit', sha: 'b', result: 'verified', basis: 'mark' },
  ];
  const s = summarize(rows, ['a', 'b']);
  assert.deepEqual(s.commits, { total: 2, verified: 1, stale: 1, none: 0, skipped: 0, unknown: 0 });
  assert.equal(s.verified_rate_pct, 50);
  assert.equal(s.verified_by_mark, 1);
  assert.equal(s.stale_paths_match, 0);
  assert.deepEqual(s.stale_files, { median: null, max: null });
});

// --- Codex doctor: project config ---------------------------------------------------------------
t('doctor warns when the project .codex/config.toml turns hooks off, and says which configs it read', (repo) => {
  fs.mkdirSync(repo.env.CODEX_HOME, { recursive: true });
  repo.env.VL_CODEX_BIN = fakeCodex(repo.home);
  repo.write('.codex/config.toml', '[features]\nhooks = false\n');
  const r = run(process.execPath, [VL, 'doctor', '--json'], { cwd: repo.dir, env: repo.env });
  const d = JSON.parse(r.stdout);
  const all = d.results.map((x) => `${x.level} ${x.msg}`).join('\n');
  assert.match(all, /warn Codex: .*\.codex[\\/]config\.toml.*hooks/);
  assert.match(all, /調べた範囲/);
});
