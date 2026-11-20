'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Repo, VL, run } = require('./helpers');

function t(name, fn, opts) {
  test(name, opts || {}, async () => {
    const repo = new Repo();
    try {
      await fn(repo);
    } finally {
      repo.cleanup();
    }
  });
}

// Every hook entry point must exit 0 and print nothing or a JSON object without `decision`.
const ENTRIES = [['skill'], ['commit'], ['expand']];

function assertSafe(r, label) {
  assert.equal(r.status, 0, `${label}: exit ${r.status} ${r.stderr}`);
  if (r.stdout.trim()) {
    assert.notEqual(r.json, undefined, `${label}: stdout is not JSON: ${r.stdout}`);
    assert.equal(typeof r.json, 'object', label);
    assert.equal('decision' in r.json, false, `${label}: must not emit decision`);
    assert.equal('continue' in r.json, false, `${label}: must not stop Claude`);
    assert.equal(r.json.hookSpecificOutput === undefined || typeof r.json.hookSpecificOutput.additionalContext === 'string', true, label);
  }
}

t('broken, empty and odd stdin never fail a hook', (repo) => {
  repo.write('a.js', 'x\n');
  repo.commit('init');
  const inputs = ['', 'not json', '{', '[]', 'null', '"str"', '42', '{}', 'true', '\u0000\u0001', '{"cwd":null,"tool_input":"x","command_name":42}',
    '{"session_id":123,"cwd":{},"tool_input":{"skill":123,"command":["a"]}}'];
  for (const args of ENTRIES) {
    for (const input of inputs) assertSafe(repo.hook(args, input), `${args.join(' ')} <${input.slice(0, 20)}>`);
  }
});

t('nonexistent and non-git cwd are harmless', (repo) => {
  for (const args of ENTRIES) {
    assertSafe(repo.hook(args, { cwd: path.join(repo.home, 'does-not-exist'), command_name: 'verify', tool_input: { skill: 'verify' } }, { cwd: repo.home }), `${args.join(' ')} missing cwd`);
    assertSafe(repo.hook(args, { cwd: repo.home, command_name: 'verify', tool_input: { skill: 'verify' } }, { cwd: repo.home }), `${args.join(' ')} non-git`);
  }
});

t('unknown or missing subcommands exit 0 with a short stderr note', (repo) => {
  for (const args of [[], ['bogus'], ['run'], ['run', 'verify']]) {
    const r = repo.hook(args, {});
    assert.equal(r.status, 0, args.join(' '));
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.split('\n').filter(Boolean).length <= 1);
  }
});

t('a broken config.json falls back to observe and the hook still works', (repo) => {
  repo.write('a.js', 'x\n');
  repo.commit('init');
  fs.mkdirSync(repo.env.VL_CONFIG_DIR, { recursive: true });
  for (const body of ['{ nope', '[]', '{"mode":"enforce","skipGlobs":"x","timeoutMs":"slow"}']) {
    fs.writeFileSync(path.join(repo.env.VL_CONFIG_DIR, 'config.json'), body);
    assertSafe(repo.commitHook(), body);
  }
  assert.equal(repo.lastCommitRow().mode, 'observe');
});

t('an unwritable ledger location does not fail the hook', (repo) => {
  repo.write('a.js', 'x\n');
  repo.commit('init');
  fs.writeFileSync(path.join(repo.dir, '.git', 'claude-verify'), 'a file where the directory should be');
  assertSafe(repo.commitHook(), 'ledger is a file');
  assertSafe(repo.verify(), 'ledger is a file (verify)');
}, { skip: process.platform === 'win32' });

t('prompt, command_args and command text never reach the ledger', (repo) => {
  const MARK = 'ZZ-MARKER-7f3a';
  repo.write('a.js', 'x\n');
  repo.commit('init');
  repo.write('a.js', 'y\n');
  repo.hook(['skill'], { tool_name: 'Skill', tool_input: { skill: 'verify', args: MARK + '-args' } });
  repo.hook(['expand'], { hook_event_name: 'UserPromptExpansion', command_name: 'verify', command_args: MARK + '-cargs', prompt: '/verify ' + MARK + '-prompt' });
  repo.hook(['expand'], { hook_event_name: 'UserPromptExpansion', command_name: 'review', command_args: MARK, prompt: MARK });
  repo.commit('msg ' + MARK + '-msg');
  repo.commitHook(`git commit -m "${MARK}-cmd"`);
  const raw = fs.readFileSync(repo.ledgerFile(), 'utf8');
  assert.ok(raw.includes('"kind":"commit"'));
  assert.equal(raw.includes(MARK), false);
  assert.equal(raw.includes('a.js'), false, 'file names must not be recorded');
});

t('ledger rows contain only the documented fields', (repo) => {
  repo.write('a.js', 'x\n');
  repo.commit('init');
  repo.write('a.js', 'y\n');
  repo.verify();
  repo.commit('c');
  repo.commitHook();
  const run = repo.ledger().find((r) => r.kind === 'run');
  const commit = repo.ledger().find((r) => r.kind === 'commit');
  const allowedRun = ['v', 'kind', 'ts', 'skill', 'via', 'agent', 'tree', 'head_sha', 'session', 'fired', 'self_check_change', 'checklist_warnings', 'ms'];
  const allowedCommit = ['v', 'kind', 'ts', 'sha', 'mode', 'agent', 'result', 'basis', 'stale_files', 'paths_match', 'head_tree_match', 'worktree_tree_match', 'cut_ts', 'since_run_s', 'session_verify', 'session_code_review', 'n_files', 'self_check_change', 'session', 'warn', 'ms'];
  for (const k of Object.keys(run)) assert.ok(allowedRun.includes(k), `run.${k}`);
  for (const k of Object.keys(commit)) assert.ok(allowedCommit.includes(k), `commit.${k}`);
  assert.equal(run.v, 1);
  assert.match(run.tree, /^[0-9a-f]{40}$/);
});

t('the real index and index.lock are never touched by the tree hash', (repo) => {
  repo.write('a.js', 'x\n');
  repo.commit('init');
  repo.write('a.js', 'y\n');
  repo.write('new.js', 'n\n');
  const idx = path.join(repo.dir, '.git', 'index');
  const before = fs.readFileSync(idx);
  const mtime = fs.statSync(idx).mtimeMs;
  fs.writeFileSync(path.join(repo.dir, '.git', 'index.lock'), ''); // someone else holds the lock
  assertSafe(repo.verify(), 'verify while index.lock exists');
  fs.unlinkSync(path.join(repo.dir, '.git', 'index.lock'));
  assert.ok(Buffer.compare(before, fs.readFileSync(idx)) === 0);
  assert.equal(fs.statSync(idx).mtimeMs, mtime);
  assert.equal(repo.ledger().filter((r) => r.kind === 'run').length, 1);
  assert.match(repo.ledger()[0].tree, /^[0-9a-f]{40}$/);
});

t('hooks stay fast on a 10,000-file repository', (repo) => {
  for (let d = 0; d < 100; d++) {
    fs.mkdirSync(path.join(repo.dir, `d${d}`), { recursive: true });
    for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(repo.dir, `d${d}`, `f${f}.js`), `x${f}\n`);
  }
  repo.commit('big');
  fs.appendFileSync(path.join(repo.dir, 'd1', 'f1.js'), 'y\n');
  const time = (fn) => {
    const t0 = process.hrtime.bigint();
    const r = fn();
    return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  };
  const v = time(() => repo.verify());
  const v2 = time(() => repo.verify()); // warm stat cache
  repo.commit('c2');
  const c = time(() => repo.commitHook());
  console.log(`# 10,000 files: verify ${v.ms.toFixed(0)} ms (warm ${v2.ms.toFixed(0)} ms), commit ${c.ms.toFixed(0)} ms (including node start-up)`);
  assertSafe(v.r, 'verify');
  assertSafe(c.r, 'commit');
  // The design target is 1 s; CI runners (especially Windows) are slower, so the hard limit is looser.
  const limit = process.env.CI ? 8000 : 3000;
  assert.ok(v.ms < limit, `verify took ${v.ms} ms`);
  assert.ok(c.ms < limit, `commit took ${c.ms} ms`);
  assert.equal(repo.lastCommitRow().result, 'verified');
}, { timeout: 120000 });

test('vl.js with no arguments prints usage without failing', () => {
  const r = run(process.execPath, [VL], {});
  assert.equal(r.status, 0);
});
