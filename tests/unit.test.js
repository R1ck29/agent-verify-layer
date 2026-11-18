'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { matchGlob, matchAny, normalizePath, toRegExp } = require('../scripts/lib/glob');
const { classify, latestRun } = require('../scripts/lib/classify');
const { parseAddedLines } = require('../scripts/lib/checklist');
const { summarize, percentile } = require('../scripts/lib/report');
const { isOwnHandler } = require('../scripts/lib/settings');
const { kindFromName } = require('../scripts/lib/hooks');
const { parseVersion, lt } = require('../scripts/lib/doctor');
const { parseJsonObject } = require('../scripts/lib/io');

test('glob: *, **, ?, braces and basename-anywhere semantics', () => {
  assert.equal(matchGlob('*.md', 'README.md'), true);
  assert.equal(matchGlob('*.md', 'docs/deep/readme.md'), true); // no "/" in glob: any depth
  assert.equal(matchGlob('src/*.js', 'src/a.js'), true);
  assert.equal(matchGlob('src/*.js', 'src/x/a.js'), false);
  assert.equal(matchGlob('src/**', 'src/x/y/a.js'), true);
  assert.equal(matchGlob('**/tests/**', 'tests/a.js'), true);
  assert.equal(matchGlob('**/tests/**', 'a/b/tests/c/d.js'), true);
  assert.equal(matchGlob('**/tests/**', 'a/mytests/c.js'), false);
  assert.equal(matchGlob('docs/**', 'docs/a/b.txt'), true);
  assert.equal(matchGlob('docs/**', 'xdocs/a.txt'), false);
  assert.equal(matchGlob('f?.js', 'f1.js'), true);
  assert.equal(matchGlob('f?.js', 'f12.js'), false);
  assert.equal(matchGlob('**/*.{js,ts}', 'a/b/c.ts'), true);
  assert.equal(matchGlob('**/*.{js,ts}', 'a/b/c.py'), false);
  assert.equal(matchGlob('*.test.*', 'a/b.test.js'), true);
  assert.equal(matchGlob('a.b', 'aXb'), false); // "." is literal
  assert.equal(matchAny(['x/**', '*.md'], 'README.md'), true);
  assert.equal(matchAny([], 'a'), false);
  assert.ok(toRegExp('src/**/*.js') instanceof RegExp);
});

test('glob: Windows separators are normalised (path.win32)', () => {
  const win = path.win32.join('src', 'hooks', 'a.js');
  assert.equal(win, 'src\\hooks\\a.js');
  assert.equal(normalizePath(win), 'src/hooks/a.js');
  assert.equal(matchGlob('src/hooks/**', win), true);
  assert.equal(matchGlob('**/hooks/*.js', 'src\\hooks\\a.js'), true);
  assert.equal(matchGlob('docs/**', 'docs\\a\\b.md'), true);
  assert.equal(matchGlob('*.md', 'docs\\readme.md'), true);
  assert.equal(normalizePath('.\\a\\b'), 'a/b');
});

test('isOwnHandler: exec-form vl.js + "hook" only, with POSIX and Windows paths', () => {
  const h = (args, extra = {}) => ({ type: 'command', command: 'node', args, ...extra });
  assert.equal(isOwnHandler(h(['/a/b/scripts/vl.js', 'hook', 'commit'])), true);
  assert.equal(isOwnHandler(h(['C:\\Users\\me\\vl\\scripts\\vl.js', 'hook', 'run', 'verify'])), true);
  assert.equal(isOwnHandler(h(['/a/b/scripts/vl.js', 'hook', 'commit'], { timeout: 99, if: 'x' })), true); // other fields ignored
  assert.equal(isOwnHandler(h(['/a/b/scripts/vl.js', 'report'])), false);
  assert.equal(isOwnHandler(h(['/a/b/notvl.js', 'hook'])), false);
  assert.equal(isOwnHandler({ type: 'command', command: 'node /a/vl.js hook commit' }), false); // shell form
  assert.equal(isOwnHandler({ type: 'http', url: 'x' }), false);
  assert.equal(isOwnHandler(null), false);
});

test('classify: skipped beats none; none; verified; stale; unreachable tree', () => {
  const skipGlobs = ['*.md', 'docs/**'];
  const run = { tree: 'T' };
  const same = () => new Set();
  assert.deepEqual(classify({ paths: ['README.md', 'docs/a.txt'], run: null, skipGlobs, diffNames: same }), { result: 'skipped', stale_files: 0 });
  assert.deepEqual(classify({ paths: [], run: null, skipGlobs, diffNames: same }), { result: 'skipped', stale_files: 0 }); // empty commit
  assert.equal(classify({ paths: ['a.js'], run: null, skipGlobs, diffNames: same }).result, 'none');
  assert.equal(classify({ paths: ['a.js'], run, skipGlobs, diffNames: same }).result, 'verified');
  assert.deepEqual(classify({ paths: ['a.js', 'b.js', 'c.js'], run, skipGlobs, diffNames: () => new Set(['a.js', 'c.js', 'zzz.js']) }), { result: 'stale', stale_files: 2 });
  assert.equal(classify({ paths: ['a.js'], run, skipGlobs, diffNames: () => new Set(['other.js']) }).result, 'verified'); // differences outside the commit are ignored
  const lost = classify({ paths: ['a.js'], run, skipGlobs, diffNames: () => null });
  assert.equal(lost.result, 'stale');
  assert.equal(lost.warn, 'tree-unreachable');
});

test('latestRun picks the newest verify run after the cut-off and ignores other rows', () => {
  const rows = [
    { kind: 'run', skill: 'verify', ts: 10, tree: 'a' },
    { kind: 'run', skill: 'code-review', ts: 30, tree: 'x' },
    { kind: 'run', skill: 'verify', ts: 20, tree: 'b' },
    { kind: 'commit', ts: 25 },
    { kind: 'run', skill: 'verify', ts: 'bad', tree: 'c' },
  ];
  assert.equal(latestRun(rows, null).tree, 'b');
  assert.equal(latestRun(rows, 20), null);
  assert.equal(latestRun(rows, 15).tree, 'b');
  assert.equal(latestRun([], null), null);
});

test('parseAddedLines keeps only added lines per file', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,2 +1,3 @@', '-old', '+new1', '+new2',
    'diff --git a/gone.js b/gone.js', '--- a/gone.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    'diff --git a/n.js b/n.js', '--- /dev/null', '+++ b/n.js', '@@ -0,0 +1 @@', '+fresh',
  ].join('\n');
  const m = parseAddedLines(diff);
  assert.deepEqual(m.get('src/a.js'), ['new1', 'new2']);
  assert.deepEqual(m.get('n.js'), ['fresh']);
  assert.equal(m.has('gone.js'), false);
});

test('report.summarize: counts, rates, percentiles and git-log reconciliation', () => {
  const rows = [
    { kind: 'run', skill: 'verify', via: 'model', ms: 10, fired: ['x'] },
    { kind: 'run', skill: 'verify', via: 'user', ms: 20, fired: ['x', 'y'] },
    { kind: 'run', skill: 'code-review', via: 'model', ms: 30 },
    { kind: 'commit', sha: 'a', result: 'verified', session_verify: true, session_code_review: false, ms: 40 },
    { kind: 'commit', sha: 'b', result: 'stale', stale_files: 3, session_verify: true, session_code_review: true, ms: 50 },
    { kind: 'commit', sha: 'c', result: 'none', session_verify: false, session_code_review: false, self_check_change: true },
    { kind: 'commit', sha: 'd', result: 'skipped' },
    { kind: 'commit', sha: 'gone', result: 'verified' },
    { kind: 'run', skill: 'verify', via: 'model', checklist_warnings: 1 },
  ];
  const s = summarize(rows, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(s.commits, { total: 5, verified: 2, stale: 1, none: 1, skipped: 1 });
  assert.equal(s.verified_rate_pct, 50); // 2 of 4 judged (skipped excluded)
  assert.equal(s.session_verify_rate_pct, 50);
  assert.equal(s.session_code_review_rate_pct, 25);
  assert.deepEqual(s.runs, { verify: 3, verify_via_model: 2, verify_via_user: 1, code_review: 1 });
  assert.deepEqual(s.stale_files, { median: 3, max: 3 });
  assert.equal(s.self_check_change_commits, 1);
  assert.deepEqual(s.checklist_fired, { x: 2, y: 1 });
  assert.equal(s.checklist_warnings, 1);
  assert.equal(s.hook_ms.max, 50);
  assert.deepEqual(s.reconcile, { git_log_commits: 6, recorded_in_log: 4, not_recorded: 2, capture_rate_pct: 66.7, recorded_not_in_log: 1 });
  const empty = summarize([], []);
  assert.equal(empty.verified_rate_pct, null);
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
});

test('small helpers: kindFromName, versions, parseJsonObject', () => {
  assert.equal(kindFromName('verify'), 'verify');
  assert.equal(kindFromName('apps/web:verify'), 'verify');
  assert.equal(kindFromName('Review'), 'code-review');
  assert.equal(kindFromName('code-review:code-review'), 'code-review');
  assert.equal(kindFromName('simplify'), null);
  assert.equal(kindFromName(undefined), null);
  assert.deepEqual(parseVersion('2.1.325 (Claude Code)'), [2, 1, 325]);
  assert.equal(parseVersion('nope'), null);
  assert.equal(lt([2, 1, 285], [2, 1, 286]), true);
  assert.equal(lt([2, 1, 286], [2, 1, 286]), false);
  assert.equal(lt([2, 2, 0], [2, 1, 999]), false);
  assert.deepEqual(parseJsonObject('[1]'), {});
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
});
