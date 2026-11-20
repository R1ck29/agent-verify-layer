'use strict';
// XREVIEW #2 (local settings and their backups never become commit candidates), #3 (shell-safe
// paths in Codex command strings), #4 (only our own hook is ever removed), #5 (the repo skill
// never leaves the repository), plus argument validation, non-git messages and partial installs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { INSTALL, VL, ROOT, tmpDir, rmrf, isolatedEnv, run } = require('./helpers');
const codex = require('../scripts/lib/codex');
const { quoteArg, splitCommand } = require('../scripts/lib/shellquote');

const posix = process.platform !== 'win32';

function t(name, fn, opts = {}) {
  test(name, opts, async () => {
    const home = tmpDir('vl-safe-');
    const env = isolatedEnv({ HOME: home });
    const ctx = {
      home,
      env,
      cx: env.CODEX_HOME,
      hooksFile: path.join(env.CODEX_HOME, 'hooks.json'),
      settings: path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'),
      cli: (args, cwd) => run(process.execPath, [INSTALL, ...args], { env, cwd: cwd || home }),
      codexCli: (args, cwd) => run(process.execPath, [INSTALL, '--agent', 'codex', '--node', process.execPath, ...args], { env, cwd: cwd || home }),
      repo(name = 'proj') {
        const dir = path.join(home, name);
        fs.mkdirSync(dir, { recursive: true });
        assert.equal(run('git', ['init', '-q'], { cwd: dir, env }).status, 0);
        return dir;
      },
      untracked: (dir) => run('git', ['ls-files', '--others', '--exclude-standard'], { cwd: dir, env }).stdout.trim().split('\n').filter(Boolean),
    };
    try {
      await fn(ctx);
    } finally {
      rmrf(home);
    }
  });
}

// --- #3 quoting ---------------------------------------------------------------------------------
test('XREVIEW #3: quoteArg keeps $ and backticks literal on POSIX and refuses what Windows shells would expand', () => {
  assert.equal(quoteArg('/a b/vl.js', { platform: 'linux', always: true }), '"/a b/vl.js"');
  assert.equal(quoteArg('/a$b/vl.js', { platform: 'linux', always: true }), "'/a$b/vl.js'");
  assert.equal(quoteArg("/o'neil/`x`/vl.js", { platform: 'linux', always: true }), "'/o'\\''neil/`x`/vl.js'");
  assert.equal(quoteArg('/usr/bin/node', { platform: 'linux' }), '/usr/bin/node');
  assert.equal(quoteArg('C:\\Program Files (x86)\\nodejs\\node.exe', { platform: 'win32' }), '"C:\\Program Files (x86)\\nodejs\\node.exe"');
  for (const bad of ['C:\\a$b\\vl.js', 'C:\\a`b\\vl.js', 'C:\\50%\\vl.js', 'C:\\a"b\\vl.js', 'a\nb']) assert.throws(() => quoteArg(bad, { platform: 'win32', always: true }), /パスに使えない文字/, bad);
  assert.throws(() => quoteArg('a\nb', { platform: 'linux' }), /パスに使えない文字/);
});

test('XREVIEW #3: splitCommand reads back what quoteArg wrote (both quote styles)', () => {
  for (const p of ['/a b/vl.js', '/a$b/vl.js', "/o'neil/vl.js", '/x/`y`/vl.js']) {
    const cmd = `${quoteArg('node', { platform: 'linux' })} ${quoteArg(p, { platform: 'linux', always: true })} hook commit --agent codex`;
    assert.deepEqual(splitCommand(cmd), ['node', p, 'hook', 'commit', '--agent', 'codex'], cmd);
  }
});

for (const action of ['--check', '--apply']) {
  t(`XREVIEW #3: Codex ${action} rejects a cmd path with delayed expansion before writes`, (c) => {
    fs.mkdirSync(c.cx, { recursive: true });
    const code = `
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const { parseArgs, run } = require(process.argv[1]);
      const result = run(parseArgs(process.argv.slice(2)));
      process.stdout.write(JSON.stringify(result.report));
      process.exitCode = result.code;
    `;
    const args = ['-e', code, '--', INSTALL, '--agent', 'codex', action, '--node', 'C:\\Tools\\!name!\\node.exe'];
    const r = run(process.execPath, args, { cwd: c.home, env: c.env });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(JSON.parse(r.stdout).error, /パスに使えない文字/);
    assert.deepEqual(fs.readdirSync(c.cx), []);
    assert.equal(fs.existsSync(c.env.VL_CONFIG_DIR), false);
  });
}

t('XREVIEW #3: delayed-expansion cmd passes an allowed path and the precise hook argv', (c) => {
  const dir = path.join(c.home, 'space & parens (ok)');
  const node = path.join(dir, 'node.exe');
  const stub = path.join(dir, 'vl.js');
  fs.mkdirSync(dir);
  fs.copyFileSync(process.execPath, node);
  fs.writeFileSync(stub, 'process.stdout.write(JSON.stringify(process.argv.slice(1)));\n');
  const cmd = codex.hookCommand(node, stub);
  const r = run(process.env.ComSpec || 'cmd.exe', ['/d', '/v:on', '/s', '/c', `"${cmd}"`], {
    cwd: c.home, windowsVerbatimArguments: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [stub, 'hook', 'commit', '--agent', 'codex']);
}, { skip: posix });

t('XREVIEW #3: a directory name with $, backtick and quote reaches the intended script through sh -c, and nothing is evaluated', (c) => {
  const dir = path.join(c.home, "a$(touch PWNED)`touch PWNED2`'q d");
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  const stub = path.join(dir, 'scripts', 'vl.js');
  fs.writeFileSync(stub, "require('fs').writeFileSync(process.argv[2] === 'hook' ? __dirname + '/argv.txt' : '/dev/null', JSON.stringify(process.argv.slice(2)));\n");
  const cmd = codex.hookCommand(process.execPath, stub);
  const r = run('sh', ['-c', cmd], { cwd: c.home });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'scripts', 'argv.txt'), 'utf8')), ['hook', 'commit', '--agent', 'codex']);
  for (const f of ['PWNED', 'PWNED2']) assert.equal(fs.existsSync(path.join(c.home, f)) || fs.existsSync(path.join(dir, f)), false, f);
}, { skip: !posix });

t('XREVIEW #3: --node with a $ in its path is written single-quoted and still recognised as ours; a path that cannot be expressed is refused before any write', (c) => {
  fs.mkdirSync(c.cx, { recursive: true });
  const r = run(process.execPath, [INSTALL, '--agent', 'codex', '--apply', '--node', '/opt/a$b/node'], { env: c.env, cwd: c.home });
  assert.equal(r.status, 0, r.stderr);
  const cmd = JSON.parse(fs.readFileSync(c.hooksFile, 'utf8')).hooks.PostToolUse[0].hooks[0].command;
  assert.ok(cmd.startsWith("'/opt/a$b/node' "), cmd);
  assert.ok(codex.isOwnCodexHandler({ type: 'command', command: cmd, statusMessage: 'verify-layer: recording commit' }, 'PostToolUse', { matcher: '^Bash$' }));
  const bad = run(process.execPath, [INSTALL, '--agent', 'codex', '--apply', '--node', '/opt/a\nb/node'], { env: c.env, cwd: c.home });
  assert.equal(bad.status, 2);
}, { skip: !posix });

// --- #4 ownership -------------------------------------------------------------------------------
const FOREIGN_SS = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "/opt/metrics/vl.js" hook audit --agent codex' }] }, { hooks: [{ type: 'command', command: 'node "/opt/metrics/vl.js" hook commit --agent codex' }] }] } };

t('XREVIEW #4 (Codex): a foreign vl.js hook in another event or group survives apply, apply and uninstall', (c) => {
  fs.mkdirSync(c.cx, { recursive: true });
  fs.writeFileSync(c.hooksFile, JSON.stringify(FOREIGN_SS, null, 2) + '\n');
  assert.equal(c.codexCli(['--apply']).status, 0);
  assert.equal(c.codexCli(['--apply']).status, 0);
  let doc = JSON.parse(fs.readFileSync(c.hooksFile, 'utf8'));
  assert.deepEqual(doc.hooks.SessionStart, FOREIGN_SS.hooks.SessionStart);
  assert.equal(doc.hooks.PostToolUse.length, 1);
  assert.equal(c.codexCli(['--uninstall']).status, 0);
  doc = JSON.parse(fs.readFileSync(c.hooksFile, 'utf8'));
  assert.deepEqual(doc, FOREIGN_SS);
});

t('XREVIEW #4 (Codex): ours is PostToolUse ^Bash$ with the exact hook commit command only', () => {
  const own = codex.ownGroups('node', '/x/scripts/vl.js')[0];
  const h = own.group.hooks[0];
  assert.equal(codex.isOwnCodexHandler(h, 'PostToolUse', own.group), true);
  assert.equal(codex.isOwnCodexHandler(h, 'SessionStart', own.group), false);
  assert.equal(codex.isOwnCodexHandler(h, 'PostToolUse', { matcher: 'Edit' }), false);
  assert.equal(codex.isOwnCodexHandler({ ...h, command: h.command.replace('commit', 'audit') }, 'PostToolUse', own.group), false);
  assert.equal(codex.isOwnCodexHandler({ ...h, statusMessage: 'mine' }, 'PostToolUse', own.group), false);
});

t('XREVIEW #4 (Claude): a foreign vl.js hook (other event, other sub-command) survives apply and uninstall', (c) => {
  const foreign = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node', args: ['/opt/metrics/vl.js', 'hook', 'audit'] }] }], PostToolUse: [{ matcher: 'Skill', hooks: [{ type: 'command', command: 'node', args: ['/opt/metrics/vl.js', 'hook', 'skill', '--other'] }] }] } };
  fs.mkdirSync(path.dirname(c.settings), { recursive: true });
  fs.writeFileSync(c.settings, JSON.stringify(foreign, null, 2) + '\n');
  assert.equal(c.cli(['--apply']).status, 0);
  assert.equal(c.cli(['--apply']).status, 0);
  assert.equal(c.cli(['--uninstall']).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.settings, 'utf8')), foreign);
});

for (const agent of ['claude', 'codex']) {
  t(`XREVIEW #4 (${agent}): a foreign hook with the same matcher, command shape and basename survives apply and uninstall`, (c) => {
    const other = path.join(c.home, 'other tool', 'scripts', 'vl.js');
    const group = agent === 'codex' ? codex.ownGroups('node', other)[0].group
      : { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node', args: [other, 'hook', 'commit'] }] };
    const value = { hooks: { PostToolUse: [group] } };
    const [file, install] = agent === 'codex' ? [c.hooksFile, c.codexCli] : [c.settings, c.cli];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value) + '\n');
    assert.equal(install(['--apply']).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PostToolUse[0], value.hooks.PostToolUse[0]);
    assert.equal(install(['--uninstall']).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), value);
  });
}

t('XREVIEW #4: both installers replace a path actually registered by a previous checkout', (c) => {
  const old = path.join(c.home, 'old-install');
  for (const dir of ['scripts', 'hooks']) fs.cpSync(path.join(ROOT, dir), path.join(old, dir), { recursive: true });
  const oldInstall = path.join(old, 'scripts', 'install.js');
  fs.mkdirSync(c.cx, { recursive: true });
  for (const agent of ['claude', 'codex']) {
    const args = [oldInstall, '--agent', agent, '--apply'];
    const r = run(process.execPath, args, { cwd: c.home, env: c.env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  const oldPath = path.join(old, 'scripts', 'vl.js');
  const oldScript = JSON.stringify(oldPath).slice(1, -1);
  fs.rmSync(oldPath);
  for (const [file, install] of [[c.settings, c.cli], [c.hooksFile, c.codexCli]]) {
    const read = () => fs.readFileSync(file, 'utf8');
    assert.ok(read().includes(oldScript));
    const check = install(['--check', '--json']);
    assert.equal(JSON.parse(check.stdout).status, 'outdated');
    assert.equal(install(['--apply']).status, 0);
    assert.ok(!read().includes(oldScript));
    assert.ok(read().includes(JSON.stringify(VL).slice(1, -1)));
  }
});

// --- #2 project scope ---------------------------------------------------------------------------
t('XREVIEW #2: project-scope apply with an ignored settings.local.json leaves no backup or secret in the work tree', (c) => {
  const repo = c.repo();
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/settings.local.json\n');
  const file = path.join(repo, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env: { API_TOKEN: 'dummy-secret-value' } }, null, 2) + '\n');
  const r = c.cli(['--apply', '--scope', 'project'], repo);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(c.untracked(repo), ['.gitignore']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('backup')), []);
  const bdir = path.join(c.env.VL_CONFIG_DIR, 'backups');
  const backups = fs.readdirSync(bdir);
  assert.equal(backups.length, 1);
  assert.ok(fs.readFileSync(path.join(bdir, backups[0]), 'utf8').includes('dummy-secret-value'));
  assert.match(r.stdout, /backups/);
});

t('XREVIEW #2: project-scope apply into a repo that does not ignore settings.local.json is refused and writes nothing', (c) => {
  const repo = c.repo();
  const r = c.cli(['--apply', '--scope', 'project'], repo);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /ignore|除外/);
  assert.equal(fs.existsSync(path.join(repo, '.claude')), false);
  assert.deepEqual(c.untracked(repo), []);
});

t('XREVIEW #2: project apply refuses a backup directory inside the work tree before copying settings', (c) => {
  const repo = c.repo();
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/settings.local.json\n');
  const file = path.join(repo, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const initial = '{"env":{"NAME":"local-only"}}\n';
  fs.writeFileSync(file, initial);
  const unsafeConfig = path.join(repo, 'local-config');
  const r = run(process.execPath, [INSTALL, '--apply', '--scope', 'project'], {
    env: { ...c.env, VL_CONFIG_DIR: unsafeConfig }, cwd: repo,
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), initial);
  assert.equal(fs.existsSync(unsafeConfig), false);
});

t('XREVIEW #2: project apply resolves a backup directory symlink before creating a backup', (c) => {
  const repo = c.repo();
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/settings.local.json\n');
  const file = path.join(repo, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const initial = '{"env":{"NAME":"local-only"}}\n';
  fs.writeFileSync(file, initial);
  fs.mkdirSync(c.env.VL_CONFIG_DIR);
  fs.symlinkSync(repo, path.join(c.env.VL_CONFIG_DIR, 'backups'), 'dir');
  const r = c.cli(['--apply', '--scope', 'project'], repo);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), initial);
  assert.deepEqual(c.untracked(repo), ['.gitignore']);
  assert.equal(fs.existsSync(path.join(c.env.VL_CONFIG_DIR, 'config.json')), false);
}, { skip: !posix });

t('XREVIEW #2: a bare repository cannot hide a backup path inside the enclosing work tree', (c) => {
  const repo = c.repo();
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/settings.local.json\n');
  const file = path.join(repo, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = '{"env":{"NAME":"local-only"}}\n';
  fs.writeFileSync(file, original);
  const nested = path.join(repo, 'nested-bare');
  const init = run('git', ['init', '--bare', '-q', nested], { cwd: repo, env: c.env });
  assert.equal(init.status, 0, init.stderr);
  fs.mkdirSync(c.env.VL_CONFIG_DIR);
  fs.symlinkSync(nested, path.join(c.env.VL_CONFIG_DIR, 'backups'), 'dir');
  const r = c.cli(['--apply', '--scope', 'project'], repo);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(c.untracked(repo).some((name) => name.includes('verify-layer-backup')), false);
}, { skip: !posix });

t('XREVIEW #2: an ignored project settings link cannot update a tracked settings file', (c) => {
  const repo = c.repo();
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/settings.local.json\nactual.json\n');
  const file = path.join(repo, '.claude', 'settings.local.json');
  const actual = path.join(repo, 'actual.json');
  const initial = '{"env":{"NAME":"local-only"}}\n';
  fs.writeFileSync(actual, initial);
  assert.equal(run('git', ['add', '-f', '--', actual], { cwd: repo, env: c.env }).status, 0);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(actual, file);
  const r = c.cli(['--apply', '--scope', 'project'], repo);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /追跡されています/);
  assert.equal(fs.readFileSync(actual, 'utf8'), initial);
  assert.equal(fs.existsSync(c.env.VL_CONFIG_DIR), false);
}, { skip: !posix });

t('XREVIEW #2: every enclosing work tree must exclude the real project settings file', (c) => {
  const outer = c.repo();
  const nested = path.join(outer, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(outer, '.gitignore'), '.claude/settings.local.json\n');
  const real = path.join(nested, 'actual.json');
  const original = '{"env":{"NAME":"local-only"}}\n';
  fs.writeFileSync(real, original);
  let git = run('git', ['add', 'nested/actual.json'], { cwd: outer, env: c.env });
  assert.equal(git.status, 0, git.stderr);
  git = run('git', ['init', '-q'], { cwd: nested, env: c.env });
  assert.equal(git.status, 0, git.stderr);
  fs.appendFileSync(path.join(nested, '.git', 'info', 'exclude'), '\nactual.json\n');
  const link = path.join(outer, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(link));
  fs.symlinkSync(real, link);
  const result = c.cli(['--apply', '--scope', 'project'], outer);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /追跡/);
  assert.equal(fs.readFileSync(real, 'utf8'), original);
  assert.equal(fs.existsSync(c.env.VL_CONFIG_DIR), false);
}, { skip: !posix });

t('XREVIEW #2: project uninstall refuses to rewrite a tracked settings target', (c) => {
  const repo = c.repo();
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/settings.local.json\nactual.json\n');
  const file = path.join(repo, '.claude', 'settings.local.json');
  const actual = path.join(repo, 'actual.json');
  fs.writeFileSync(actual, '{"env":{"NAME":"local-only"}}\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(actual, file);
  assert.equal(c.cli(['--apply', '--scope', 'project'], repo).status, 0);
  assert.equal(run('git', ['add', '-f', '--', actual], { cwd: repo, env: c.env }).status, 0);
  const before = fs.readFileSync(actual, 'utf8');
  const r = c.cli(['--uninstall', '--scope', 'project'], repo);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /追跡されています/);
  assert.equal(fs.readFileSync(actual, 'utf8'), before);
}, { skip: !posix });

// --- #5 repo skill containment ------------------------------------------------------------------
t('XREVIEW #5: --repo-skill refuses when .agents/skills resolves outside the repository (apply and uninstall write and delete nothing there)', (c) => {
  fs.mkdirSync(c.cx, { recursive: true });
  const repo = c.repo();
  const outside = path.join(c.home, 'shared-skills');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(repo, '.agents'));
  fs.symlinkSync(outside, path.join(repo, '.agents', 'skills'), 'dir');
  let r = c.codexCli(['--repo-skill', '--apply', '--project-dir', repo]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /リポジトリの外/);
  assert.deepEqual(fs.readdirSync(outside), []);
  // an identical file already lives in the shared place: uninstall must not delete it
  fs.mkdirSync(path.join(outside, 'verify'));
  fs.copyFileSync(path.join(ROOT, 'codex', 'skills', 'verify', 'SKILL.md'), path.join(outside, 'verify', 'SKILL.md'));
  r = c.codexCli(['--repo-skill', '--uninstall', '--project-dir', repo]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(outside, 'verify', 'SKILL.md')));
  r = c.codexCli(['--repo-skill', '--check', '--project-dir', repo]);
  assert.equal(r.status, 2);
}, { skip: !posix });

// --- argument validation, non-git message, partial install ----------------------------------------
t('every option that takes a value is validated before any change', (c) => {
  for (const args of [['--uninstall', '--scope'], ['--apply', '--mode'], ['--apply', '--settings-file'], ['--apply', '--scope', '--mode', 'off'], ['--check', '--project-dir']]) {
    const r = c.cli(args);
    assert.equal(r.status, 2, args.join(' ') + r.stdout + r.stderr);
    assert.match(r.stderr + r.stdout, /値が必要/);
  }
  assert.equal(fs.existsSync(c.settings), false);
});

t('--repo-skill on an explicit directory outside git names that directory', (c) => {
  fs.mkdirSync(c.cx, { recursive: true });
  const dir = path.join(c.home, 'not-a-repo');
  fs.mkdirSync(dir);
  const r = c.codexCli(['--repo-skill', '--apply', '--project-dir', dir]);
  assert.equal(r.status, 2);
  assert.ok((r.stdout + r.stderr).includes(`指定した ${dir} は Git リポジトリ内ではありません`), r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(dir, '.agents')), false);
  fs.mkdirSync(path.join(dir, '.git-not'), { recursive: true });
  assert.equal(run('git', ['init', '-q'], { cwd: dir, env: c.env }).status, 0);
  assert.equal(c.codexCli(['--repo-skill', '--apply', '--project-dir', dir]).status, 0);
});

t('a hooks.json that cannot be replaced does not leave AGENTS.md changed (every target is checked before the first write)', (c) => {
  if (process.getuid && process.getuid() === 0) return; // root ignores modes
  fs.mkdirSync(c.cx, { recursive: true });
  fs.writeFileSync(path.join(c.cx, 'AGENTS.md'), 'mine\n');
  // the file is writable, its directory is not: the atomic write (and the backup) would fail
  const ro = path.join(c.home, 'ro');
  fs.mkdirSync(ro);
  fs.writeFileSync(path.join(ro, 'hooks.json'), '{}\n');
  fs.chmodSync(ro, 0o555);
  try {
    const r = c.codexCli(['--apply', '--agents-md', '--hooks-file', path.join(ro, 'hooks.json')]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(c.cx, 'AGENTS.md'), 'utf8'), 'mine\n');
    assert.deepEqual(fs.readdirSync(c.cx).filter((f) => f.includes('backup')), []);
  } finally {
    fs.chmodSync(ro, 0o755);
  }
}, { skip: !posix });

t('XREVIEW #4 (Claude): ownership includes the matcher: a foreign `vl.js hook commit` under another matcher survives', (c) => {
  const foreign = { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node', args: ['/opt/metrics/vl.js', 'hook', 'commit'] }] }] } };
  fs.mkdirSync(path.dirname(c.settings), { recursive: true });
  fs.writeFileSync(c.settings, JSON.stringify(foreign, null, 2) + '\n');
  assert.equal(c.cli(['--apply']).status, 0);
  assert.equal(c.cli(['--uninstall']).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.settings, 'utf8')), foreign);
});

test('settings.SUBCOMMANDS equals hooks/hooks.json (event and matcher of every own handler)', () => {
  const { SUBCOMMANDS, isOwnHandler } = require('../scripts/lib/settings');
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  let n = 0;
  for (const [event, groups] of Object.entries(tpl.hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        assert.equal(isOwnHandler(h, event, g), true, `${event} ${g.matcher} ${h.args.join(' ')}`);
        assert.equal(SUBCOMMANDS[h.args[h.args.length - 1]].matcher, g.matcher);
        n++;
      }
    }
  }
  assert.equal(n, 4);
});

t('--repo-skill --uninstall with .agents/skills linked to a directory inside the repo does not crash half-way', (c) => {
  fs.mkdirSync(c.cx, { recursive: true });
  const repo = c.repo();
  fs.mkdirSync(path.join(repo, 'docs', 'verify'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'codex', 'skills', 'verify', 'SKILL.md'), path.join(repo, 'docs', 'verify', 'SKILL.md'));
  fs.mkdirSync(path.join(repo, '.agents'));
  fs.symlinkSync(path.join(repo, 'docs'), path.join(repo, '.agents', 'skills'), 'dir');
  const r = c.codexCli(['--repo-skill', '--uninstall', '--project-dir', repo]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
}, { skip: !posix });

t('an inherited GIT_DIR does not change which repository decides whether settings.local.json is ignored', (c) => {
  const other = c.repo('other');
  fs.writeFileSync(path.join(other, '.gitignore'), '.claude/settings.local.json\n');
  const proj = c.repo('proj'); // does NOT ignore the file
  const r = run(process.execPath, [INSTALL, '--apply', '--scope', 'project'], { cwd: proj, env: { ...c.env, GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(proj, '.claude')), false);
});
