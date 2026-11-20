'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { INSTALL, VL, ROOT, tmpDir, rmrf, isolatedEnv, run } = require('./helpers');

// A throw-away CLAUDE_CONFIG_DIR / VL_CONFIG_DIR per test; the real ~/.claude is never touched.
function t(name, fn, opts) {
  test(name, opts || {}, async () => {
    const home = tmpDir('vl-inst-');
    const env = isolatedEnv({ HOME: home });
    const ctx = {
      home,
      env,
      settings: path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'),
      config: path.join(env.VL_CONFIG_DIR, 'config.json'),
      install(...args) {
        return run(process.execPath, [INSTALL, ...args], { env, cwd: opts && opts.cwd ? opts.cwd : home });
      },
      read: () => JSON.parse(fs.readFileSync(ctx.settings, 'utf8')),
      put(obj, indent = 2) {
        fs.mkdirSync(path.dirname(ctx.settings), { recursive: true });
        fs.writeFileSync(ctx.settings, typeof obj === 'string' ? obj : JSON.stringify(obj, null, indent) + '\n');
      },
      backups: () => fs.readdirSync(path.dirname(ctx.settings)).filter((f) => f.includes('verify-layer-backup')),
    };
    try {
      await fn(ctx);
    } finally {
      rmrf(home);
    }
  });
}

const ECC_LIKE = {
  model: 'sonnet',
  env: { SOME: 'value' },
  permissions: { allow: ['Bash(ls *)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash /opt/ecc/pre-bash.sh', timeout: 5 }] }],
    PostToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash /opt/ecc/post-bash.sh' }] },
      { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/x.js'], timeout: 3 }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'bash /opt/ecc/stop.sh' }] }],
  },
};

const ownCount = (settings) => JSON.stringify(settings).split('hook').length && (JSON.stringify(settings).match(/scripts[\\/]+vl\.js/g) || []).length;

t('--check is the default, reads only and never writes (missing and existing settings)', (c) => {
  let r = c.install();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /未導入/);
  assert.equal(fs.existsSync(c.settings), false);
  assert.equal(fs.existsSync(path.dirname(c.settings)), false);

  c.put(ECC_LIKE);
  const before = fs.readFileSync(c.settings, 'utf8');
  r = c.install('--check');
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(c.settings, 'utf8'), before);
  assert.deepEqual(c.backups(), []);
  assert.equal(fs.existsSync(c.config), false);
});

t('--apply installs 5 exec-form handlers with absolute vl.js paths, observe config and a backup', (c) => {
  c.put(ECC_LIKE);
  const r = c.install('--apply');
  assert.equal(r.status, 0, r.stderr);
  const s = c.read();
  const own = [];
  for (const [event, groups] of Object.entries(s.hooks)) for (const g of groups) for (const h of g.hooks) if ((h.args || []).some((a) => /vl\.js$/.test(a))) own.push({ event, g, h });
  assert.equal(own.length, 4);
  for (const { h } of own) {
    assert.equal(h.command, 'node');
    assert.ok(path.isAbsolute(h.args[0]), h.args[0]);
    assert.equal(h.args[0], VL);
    assert.equal(h.args[1], 'hook');
    assert.equal(h.onFailure, 'continue');
  }
  assert.deepEqual(own.map((o) => o.h.if).filter(Boolean).sort(), ['Bash(git commit *)', 'PowerShell(git commit *)']);
  assert.equal(c.backups().length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.config, 'utf8')), { mode: 'observe' });
});

t('--apply keeps every foreign hook, setting and group order untouched', (c) => {
  c.put(ECC_LIKE);
  c.install('--apply');
  const s = c.read();
  assert.equal(s.model, 'sonnet');
  assert.deepEqual(s.env, ECC_LIKE.env);
  assert.deepEqual(s.permissions, ECC_LIKE.permissions);
  assert.deepEqual(s.hooks.PreToolUse, ECC_LIKE.hooks.PreToolUse);
  assert.deepEqual(s.hooks.Stop, ECC_LIKE.hooks.Stop);
  assert.deepEqual(s.hooks.PostToolUse.slice(0, 2), ECC_LIKE.hooks.PostToolUse); // ours come after
  assert.equal(s.hooks.PostToolUse.length, 4);
});

t('--apply twice is byte-identical, writes no second backup and says so', (c) => {
  c.put(ECC_LIKE);
  c.install('--apply');
  const once = fs.readFileSync(c.settings, 'utf8');
  const r = c.install('--apply');
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(c.settings, 'utf8'), once);
  assert.equal(c.backups().length, 1);
  assert.match(r.stdout, /既に目的の状態/);
  assert.equal(ownCount(c.read()), 4);
  assert.match(c.install('--check').stdout, /導入済み（最新）/);
});

t('--apply onto an empty or missing settings file works', (c) => {
  assert.equal(c.install('--apply').status, 0);
  assert.equal(ownCount(c.read()), 4);
  c.put('{}\n');
  assert.equal(c.install('--apply').status, 0);
  assert.equal(ownCount(c.read()), 4);
});

t('--uninstall removes only our hooks: the result equals the original settings', (c) => {
  c.put(ECC_LIKE);
  c.install('--apply');
  const r = c.install('--uninstall');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(c.read(), ECC_LIKE);
  assert.match(r.stdout, /台帳/); // ledgers are left for the user to decide
});

t('--uninstall of a settings file we created leaves nothing behind but the backup', (c) => {
  c.install('--apply');
  c.install('--uninstall');
  assert.equal(fs.existsSync(c.settings), false);
  assert.ok(c.backups().length >= 1);
});

t('foreign handlers that merely mention vl.js (shell form, other tools) are never treated as ours', (c) => {
  const foreign = {
    hooks: {
      PostToolUse: [{
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: 'node /opt/othertool/vl.js hook run x' },
          { type: 'command', command: 'echo see /tmp/vl.js hook docs' },
          { type: 'command', command: 'node "/opt/o t/vl.js" hook commit' },
          { type: 'command', command: 'node', args: ['/opt/other/vl.js', 'status'] },
          { type: 'command', command: 'node', args: ['/opt/other/notvl.js', 'hook', 'commit'] },
        ],
      }],
    },
  };
  c.put(foreign);
  assert.match(c.install('--check').stdout, /未導入/);
  c.install('--apply');
  c.install('--uninstall');
  assert.deepEqual(c.read(), foreign);
});

t('an unregistered old path does not count as an installed Claude hook', (c) => {
  c.put({ hooks: { PostToolUse: [{ matcher: 'Skill', hooks: [{ type: 'command', command: 'node', args: ['/old/place/scripts/vl.js', 'hook', 'skill'] }] }] } });
  assert.match(c.install('--check').stdout, /未導入/);
  c.install('--apply');
  const raw = fs.readFileSync(c.settings, 'utf8');
  assert.ok(raw.includes('/old/place/scripts/vl.js'));
  assert.equal(ownCount(c.read()), 5);
});

t('JSON that cannot be parsed (or is not an object) is refused and left untouched', (c) => {
  for (const body of ['{ "hooks": ', '// comment\n{}', '[]', '"x"']) {
    c.put(body);
    for (const mode of ['--apply', '--uninstall', '--check']) {
      const r = c.install(mode);
      assert.equal(r.status, 2, `${mode} ${body}`);
      assert.equal(fs.readFileSync(c.settings, 'utf8'), body);
    }
  }
  assert.deepEqual(c.backups(), []);
});

t('indentation and a BOM are handled; the file stays valid JSON', (c) => {
  c.put(ECC_LIKE, 4);
  c.install('--apply');
  assert.match(fs.readFileSync(c.settings, 'utf8'), /\n {4}"model"/);
  c.put('﻿' + JSON.stringify(ECC_LIKE));
  assert.equal(c.install('--apply').status, 0);
  assert.equal(fs.readFileSync(c.settings, 'utf8').charCodeAt(0), '{'.charCodeAt(0));
});

t('same-second apply and uninstall never overwrite an earlier backup', (c) => {
  c.put({ original: true });
  c.install('--apply');
  c.install('--uninstall');
  const originals = c.backups().filter((f) => JSON.parse(fs.readFileSync(path.join(path.dirname(c.settings), f), 'utf8')).original && !JSON.parse(fs.readFileSync(path.join(path.dirname(c.settings), f), 'utf8')).hooks);
  assert.equal(originals.length, 1, 'the pre-install original must survive');
});

t('--scope project targets .claude/settings.local.json inside the repo and uninstall removes the emptied file', (c) => {
  const repo = path.join(c.home, 'proj');
  fs.mkdirSync(repo);
  assert.equal(run('git', ['init', '-q'], { cwd: repo, env: c.env }).status, 0);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/settings.local.json\n'); // required: the file must not become a commit candidate
  const file = path.join(repo, '.claude', 'settings.local.json');
  let r = run(process.execPath, [INSTALL, '--apply', '--scope', 'project'], { cwd: repo, env: c.env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))).includes('vl.js'), true);
  assert.equal(fs.existsSync(c.settings), false, 'user settings untouched');
  r = run(process.execPath, [INSTALL, '--uninstall', '--scope', 'project'], { cwd: repo, env: c.env });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(file), false);
  assert.equal(run(process.execPath, [INSTALL, '--apply', '--scope', 'nowhere'], { cwd: repo, env: c.env }).status, 2);
});

t('--settings-file and --mode off', (c) => {
  const file = path.join(c.home, 'custom', 's.json');
  const r = c.install('--apply', '--settings-file', file, '--mode', 'off');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.config, 'utf8')), { mode: 'off' });
  assert.equal(c.install('--apply', '--mode', 'enforce').status, 2); // enforce does not exist in v0.1
  c.install('--apply', '--settings-file', file); // a later apply keeps the chosen mode
  assert.deepEqual(JSON.parse(fs.readFileSync(c.config, 'utf8')), { mode: 'off' });
});

t('--rules copies the rules file, protects an edited one, and uninstall keeps edits', (c) => {
  const dest = path.join(c.env.CLAUDE_CONFIG_DIR, 'rules', 'verification.md');
  c.install('--apply', '--rules');
  assert.equal(fs.readFileSync(dest, 'utf8'), fs.readFileSync(path.join(ROOT, 'rules', 'verification.md'), 'utf8'));
  fs.writeFileSync(dest, 'my own rule\n');
  let r = c.install('--apply', '--rules');
  assert.match(r.stdout, /上書きしませんでした/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'my own rule\n');
  c.install('--uninstall', '--rules');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'my own rule\n');
  c.install('--apply', '--rules', '--force');
  c.install('--uninstall', '--rules', '--purge');
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(path.dirname(c.config)), false); // --purge removed the config dir
});

t('uninstall when never installed writes nothing', (c) => {
  c.put(ECC_LIKE);
  const before = fs.readFileSync(c.settings, 'utf8');
  const r = c.install('--uninstall');
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(c.settings, 'utf8'), before);
  assert.deepEqual(c.backups(), []);
});

t('unknown options are rejected', (c) => {
  assert.equal(c.install('--frobnicate').status, 2);
});

t('file mode is preserved and a symlinked settings file is written through', (c) => {
  const real = path.join(c.home, 'dotfiles', 's.json');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '{}\n', { mode: 0o600 });
  fs.mkdirSync(path.dirname(c.settings), { recursive: true });
  fs.symlinkSync(real, c.settings);
  assert.equal(c.install('--apply').status, 0);
  assert.equal(fs.lstatSync(c.settings).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).hooks.PostToolUse.length, 2);
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  c.install('--uninstall');
  assert.equal(fs.lstatSync(c.settings).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), {});
}, { skip: process.platform === 'win32' });

t('a read-only settings file is refused with nothing written', (c) => {
  c.put({ keep: 1 });
  fs.chmodSync(c.settings, 0o444);
  const r = c.install('--apply');
  assert.equal(r.status, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.settings, 'utf8')), { keep: 1 });
  assert.deepEqual(c.backups(), []);
}, { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) });

t('Claude settings with hooks or an event of an unexpected shape: refused with exit 2, nothing written', (c) => {
  for (const doc of [{ model: 'x', hooks: { PostToolUse: { matcher: 'Bash' } } }, { hooks: [] }, { hooks: 'x' }]) {
    c.put(doc);
    const before = fs.readFileSync(c.settings, 'utf8');
    const r = c.install('--apply');
    assert.equal(r.status, 2, before);
    assert.match(r.stdout, /何も書いていません/);
    assert.equal(fs.readFileSync(c.settings, 'utf8'), before);
    assert.deepEqual(c.backups(), []);
  }
});
