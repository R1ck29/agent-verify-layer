'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Repo, VL, INSTALL, run } = require('./helpers');

function t(name, fn, opts) {
  test(name, opts || {}, async () => {
    const repo = new Repo();
    try {
      repo.write('src/a.js', 'x\n');
      repo.commit('init');
      await fn(repo);
    } finally {
      repo.cleanup();
    }
  });
}

const doctor = (repo, args = [], env = {}) => {
  const r = run(process.execPath, [VL, 'doctor', '--json', ...args], { cwd: repo.dir, env: { ...repo.env, ...env } });
  let data = null;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    /* reported by the assertions */
  }
  return { ...r, data };
};
const msgs = (d, level) => d.data.results.filter((x) => x.level === level).map((x) => x.msg).join('\n');
const settingsFile = (repo) => path.join(repo.env.CLAUDE_CONFIG_DIR, 'settings.json');
const putSettings = (repo, obj) => {
  fs.mkdirSync(path.dirname(settingsFile(repo)), { recursive: true });
  fs.writeFileSync(settingsFile(repo), JSON.stringify(obj));
};

t('doctor in a clean environment: exit 0, valid JSON, every hook runs in a throw-away repo', (repo) => {
  const d = doctor(repo);
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.equal(d.data.ng, 0);
  const ok = msgs(d, 'ok');
  for (const label of ['hook run verify', 'hook run code-review', 'hook expand', 'hook commit']) assert.match(ok, new RegExp(label));
  assert.match(msgs(d, 'warn'), /settings にもプラグインにも見つかりません/); // nothing is wired yet
});

t('doctor never writes into the inspected repo or the config dirs', (repo) => {
  const before = repo.git('status', '--porcelain', '--ignored');
  doctor(repo);
  assert.equal(repo.git('status', '--porcelain', '--ignored'), before);
  assert.deepEqual(repo.ledger(), []);
  assert.equal(fs.existsSync(path.join(repo.env.VL_CONFIG_DIR, 'config.json')), false);
});

t('doctor flags the conditions that remove the standard pre-commit verify instruction', (repo) => {
  const cases = [
    [{ includeGitInstructions: false }, /includeGitInstructions/],
    [{ disableAllHooks: true }, /disableAllHooks/],
    [{ skillOverrides: { verify: 'user-invocable-only' } }, /skillOverrides\.verify/],
    [{ skillOverrides: { simplify: 'off' } }, /skillOverrides\.simplify/],
    [{ env: { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' } }, /CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS/],
  ];
  for (const [settings, re] of cases) {
    putSettings(repo, settings);
    const d = doctor(repo);
    assert.equal(d.status, 1, JSON.stringify(settings));
    assert.match(msgs(d, 'ng'), re);
  }
  putSettings(repo, { skillOverrides: { verify: 'on' }, includeGitInstructions: true });
  assert.equal(doctor(repo).status, 0);
  const d = doctor(repo, [], { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' });
  assert.equal(d.status, 1);
  assert.equal(doctor(repo, [], { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '0' }).status, 0);
});

t('doctor warns about strictPluginOnlyCustomization and personal verify/simplify skills, errors on a non-invocable project verify', (repo) => {
  putSettings(repo, {});
  fs.writeFileSync(settingsFile(repo), JSON.stringify({ strictPluginOnlyCustomization: ['skills'] }));
  // strictPluginOnlyCustomization only counts when it comes from managed settings, so a user file must not raise it
  assert.doesNotMatch(msgs(doctor(repo), 'warn'), /strictPluginOnlyCustomization/);

  fs.mkdirSync(path.join(repo.env.CLAUDE_CONFIG_DIR, 'skills', 'verify'), { recursive: true });
  fs.writeFileSync(path.join(repo.env.CLAUDE_CONFIG_DIR, 'skills', 'verify', 'SKILL.md'), '---\nname: verify\n---\n');
  assert.match(msgs(doctor(repo), 'warn'), /個人用の verify/);

  repo.write('.claude/skills/verify/SKILL.md', '---\nname: verify\ndisable-model-invocation: true\n---\nrecipe\r\n');
  let d = doctor(repo);
  assert.equal(d.status, 1);
  assert.match(msgs(d, 'ng'), /disable-model-invocation/);

  repo.write('.claude/skills/verify/SKILL.md', '---\nname: verify\n---\nrecipe\n');
  d = doctor(repo);
  assert.equal(d.status, 0);
  assert.match(msgs(d, 'ok'), /verify の記録があります/);
});

t('doctor recognises an installed setup, reports partial wiring, and flags mode=off', (repo) => {
  assert.equal(run(process.execPath, [INSTALL, '--apply'], { cwd: repo.dir, env: repo.env }).status, 0);
  let d = doctor(repo);
  assert.equal(d.status, 0, d.stdout);
  assert.match(msgs(d, 'ok'), /verify-layer の hook があります/);
  assert.doesNotMatch(msgs(d, 'warn'), /揃っていません|見つかりません/);

  const s = JSON.parse(fs.readFileSync(settingsFile(repo), 'utf8'));
  delete s.hooks.UserPromptExpansion;
  fs.writeFileSync(settingsFile(repo), JSON.stringify(s));
  assert.match(msgs(doctor(repo), 'warn'), /hook expand/);

  repo.config({ mode: 'off' });
  assert.match(msgs(doctor(repo), 'warn'), /mode=off/);
});

t('doctor errors when a registered vl.js no longer exists', (repo) => {
  putSettings(repo, { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: [path.join(repo.home, 'gone', 'scripts', 'vl.js'), 'hook', 'commit'] }] }] } });
  const d = doctor(repo);
  assert.equal(d.status, 1);
  assert.match(msgs(d, 'ng'), /存在しません/);
});

t('doctor tolerates unreadable settings (reports a warning, does not crash)', (repo) => {
  fs.mkdirSync(repo.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(settingsFile(repo), '{ broken');
  const d = doctor(repo);
  assert.equal(d.status, 0);
  assert.match(msgs(d, 'warn'), /読めません/);
});

t('doctor text output ends with a summary line', (repo) => {
  const r = run(process.execPath, [VL, 'doctor'], { cwd: repo.dir, env: repo.env });
  assert.match(r.stdout, /結果: NG 0 件/);
});

t('report: text and JSON over a real ledger; reconciliation with git log', (repo) => {
  repo.write('src/a.js', 'y\n');
  repo.verify();
  repo.commit('verified one');
  repo.commitHook();
  repo.write('src/a.js', 'z\n');
  repo.commit('unverified one');
  repo.commitHook('git commit -m x');
  repo.write('src/a.js', 'w\n');
  repo.commit('made outside the hook'); // never reaches the ledger

  const j = run(process.execPath, [VL, 'report', '--json'], { cwd: repo.dir, env: repo.env });
  assert.equal(j.status, 0, j.stderr);
  const s = JSON.parse(j.stdout);
  assert.deepEqual(s.commits, { total: 2, verified: 1, stale: 0, none: 1, skipped: 0 });
  assert.equal(s.runs.verify, 1);
  assert.equal(s.verified_rate_pct, 50);
  assert.equal(s.reconcile.not_recorded >= 1, true);
  assert.equal(s.reconcile.recorded_in_log, 2);

  const txt = run(process.execPath, [VL, 'report'], { cwd: repo.dir, env: repo.env });
  assert.match(txt.stdout, /verified 1 \/ stale 0 \/ none 1 \/ skipped 0/);
  assert.match(txt.stdout, /git log との突き合わせ/);

  assert.equal(run(process.execPath, [VL, 'report', '--days', '1', '--json'], { cwd: repo.dir, env: repo.env }).status, 0);
  assert.equal(run(process.execPath, [VL, 'report', '--days', 'abc'], { cwd: repo.dir, env: repo.env }).status, 2);
  assert.equal(run(process.execPath, [VL, 'report', '--repo', repo.dir, '--json'], { cwd: repo.home, env: repo.env }).status, 0);
});

t('report on an empty ledger prints placeholders and exits 0; outside a repo it exits 1', (repo) => {
  const r = run(process.execPath, [VL, 'report'], { cwd: repo.dir, env: repo.env });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /0 件/);
  assert.equal(run(process.execPath, [VL, 'report'], { cwd: repo.home, env: repo.env }).status, 1);
});
