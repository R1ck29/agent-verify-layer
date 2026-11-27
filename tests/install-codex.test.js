'use strict';
// `install.js --agent codex` against a throw-away HOME / CODEX_HOME. The real ~/.codex, ~/.claude
// and codex binary are never touched (helpers.isolatedEnv points CODEX_HOME and VL_CODEX_BIN away).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { INSTALL, VL, ROOT, Repo, tmpDir, rmrf, isolatedEnv, run, fakeCodex } = require('./helpers');
const codex = require('../scripts/lib/codex');

const TEMPLATE = path.join(ROOT, 'codex', 'skills', 'verify', 'SKILL.md');
const FOREIGN = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'samplectl-session-start', timeout: 5 }] }],
    PostToolUse: [
      { matcher: 'Edit|Write|apply_patch', hooks: [{ type: 'command', command: 'samplectl-post-edit' }] },
      { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'code-review-graph update --quiet' }] },
    ],
  },
};

function t(name, fn) {
  test(name, async () => {
    const home = tmpDir('vl-cx-');
    const env = isolatedEnv({ HOME: home });
    const cx = env.CODEX_HOME;
    const ctx = {
      home,
      env,
      cx,
      hooksFile: path.join(cx, 'hooks.json'),
      agentsFile: path.join(cx, 'AGENTS.md'),
      mkCodexHome: () => fs.mkdirSync(cx, { recursive: true }),
      install(args, opts = {}) {
        const r = run(process.execPath, [INSTALL, '--agent', 'codex', '--node', process.execPath, ...args], { env: { ...env, ...(opts.env || {}) }, cwd: opts.cwd || home });
        let json = null;
        if (args.includes('--json')) {
          try {
            json = JSON.parse(r.stdout);
          } catch {
            /* asserted by callers */
          }
        }
        return { ...r, json };
      },
      putHooks(obj, indent = 2) {
        ctx.mkCodexHome();
        fs.writeFileSync(ctx.hooksFile, typeof obj === 'string' ? obj : JSON.stringify(obj, null, indent) + '\n');
      },
      readHooks: () => JSON.parse(fs.readFileSync(ctx.hooksFile, 'utf8')),
      backups: () => (fs.existsSync(cx) ? fs.readdirSync(cx).filter((f) => f.includes('verify-layer-backup')) : []),
    };
    try {
      await fn(ctx);
    } finally {
      rmrf(home);
    }
  });
}

const ownHandlers = (doc) => {
  const out = [];
  for (const [event, groups] of Object.entries(doc.hooks || {})) for (const g of groups) for (const h of g.hooks) if (codex.isOwnCodexHandler(h)) out.push({ event, g, h });
  return out;
};
const withoutOwn = (doc) => {
  const copy = JSON.parse(JSON.stringify(doc));
  for (const [event, groups] of Object.entries(copy.hooks)) {
    copy.hooks[event] = groups.map((g) => ({ ...g, hooks: g.hooks.filter((h) => !codex.isOwnCodexHandler(h)) })).filter((g) => g.hooks.length);
    if (!copy.hooks[event].length) delete copy.hooks[event];
  }
  return copy;
};

// --- detection -------------------------------------------------------------------------------

t('no Codex (no CODEX_HOME, no codex command): --check says so and exits 0, --apply writes nothing and exits 3', (c) => {
  let r = c.install(['--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 'codex-not-found');
  r = c.install(['--apply', '--agents-md']);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /Codex が見つかりません/);
  assert.equal(fs.existsSync(c.cx), false);
});

t('a codex command on PATH counts as Codex even without CODEX_HOME', (c) => {
  const r = c.install(['--json'], { env: { VL_CODEX_BIN: fakeCodex(c.home) } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 'not-installed');
  assert.equal(fs.existsSync(c.hooksFile), false);
});

// --- hooks.json --------------------------------------------------------------------------------

t('--check is the default and never writes (missing and existing hooks.json)', (c) => {
  c.mkCodexHome();
  let r = c.install(['--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.action, 'check');
  assert.equal(r.json.status, 'not-installed');
  assert.ok(r.json.changes.some((x) => /PostToolUse \[\^Bash\$\]/.test(x)));
  assert.equal(fs.existsSync(c.hooksFile), false);

  c.putHooks(FOREIGN);
  const before = fs.readFileSync(c.hooksFile, 'utf8');
  r = c.install(['--agents-md']);
  c.install(['--repo-skill', '--project-dir', c.home]);
  assert.equal(fs.readFileSync(c.hooksFile, 'utf8'), before);
  assert.equal(fs.existsSync(c.agentsFile), false);
  assert.deepEqual(c.backups(), []);
});

t('--apply adds one PostToolUse ^Bash$ handler (absolute vl.js, timeout 10) and keeps every foreign hook as is', (c) => {
  c.putHooks(FOREIGN);
  const r = c.install(['--apply']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\/hooks/); // the trust step is announced
  const doc = c.readHooks();
  const own = ownHandlers(doc);
  assert.equal(own.length, 1);
  assert.equal(own[0].event, 'PostToolUse');
  assert.equal(own[0].g.matcher, '^Bash$');
  assert.equal(own[0].h.timeout, 10);
  assert.equal(codex.ownScriptPath(own[0].h), VL);
  assert.ok(path.isAbsolute(codex.ownScriptPath(own[0].h)));
  assert.deepEqual(withoutOwn(doc), FOREIGN);
  assert.equal(c.backups().length, 1);
});

t('--apply is idempotent: the second run changes no byte and makes no backup', (c) => {
  c.putHooks(FOREIGN, 4);
  assert.equal(c.install(['--apply']).status, 0);
  const once = fs.readFileSync(c.hooksFile, 'utf8');
  assert.match(once, /\n {4}"hooks"/); // the user's indentation is kept
  const backups = c.backups().length;
  const r = c.install(['--apply', '--json']);
  assert.equal(r.status, 0);
  assert.equal(r.json.upToDate, true);
  assert.equal(fs.readFileSync(c.hooksFile, 'utf8'), once);
  assert.equal(c.backups().length, backups);
  assert.equal(c.install(['--json']).json.status, 'installed');
});

t('an unregistered old path does not count as an installed Codex hook', (c) => {
  const stale = { matcher: '^Bash$', hooks: [{ type: 'command', command: 'node "/old/place/scripts/vl.js" hook commit --agent codex', timeout: 10, statusMessage: 'verify-layer: recording commit' }] };
  c.putHooks({ hooks: { ...FOREIGN.hooks, PostToolUse: [stale, ...FOREIGN.hooks.PostToolUse] } });
  assert.equal(c.install(['--json']).json.status, 'not-installed');
  assert.equal(c.install(['--apply']).status, 0);
  const own = ownHandlers(c.readHooks());
  assert.equal(own.length, 2);
  assert.deepEqual(own.map(({ h }) => codex.ownScriptPath(h)), ['/old/place/scripts/vl.js', VL]);
  assert.deepEqual(withoutOwn(c.readHooks()), FOREIGN);
});

t('a foreign command that only mentions vl.js is never treated as ours', (c) => {
  const foreign = { hooks: { PostToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'node "/x/vl.js" report' }, { type: 'command', command: 'echo vl.js hook commit --agent codex' }] }] } };
  c.putHooks(foreign);
  assert.equal(c.install(['--apply']).status, 0);
  assert.equal(c.install(['--uninstall']).status, 0);
  assert.deepEqual(c.readHooks(), foreign);
});

t('--uninstall removes only our handler; a file that only held ours is deleted (backup kept)', (c) => {
  c.putHooks(FOREIGN);
  c.install(['--apply']);
  let r = c.install(['--uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(c.readHooks(), FOREIGN);

  rmrf(c.cx);
  c.mkCodexHome();
  c.install(['--apply']);
  r = c.install(['--uninstall']);
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(c.hooksFile), false);
  assert.ok(c.backups().length >= 1);
});

t('broken hooks.json: exit 2, file untouched', (c) => {
  c.putHooks('{ not json');
  const r = c.install(['--apply']);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(c.hooksFile, 'utf8'), '{ not json');
});

t('hooks or PostToolUse of an unexpected shape: refused with exit 2 for every action, nothing written', (c) => {
  const shapes = [
    { hooks: { PostToolUse: { matcher: 'x', hooks: [{ type: 'command', command: 'echo keepme' }] } } },
    { hooks: { PostToolUse: 'some-string' } },
    { hooks: [{ matcher: 'x' }] },
    { hooks: 'str' },
    { hooks: null },
  ];
  for (const doc of shapes) {
    c.putHooks(doc);
    const before = fs.readFileSync(c.hooksFile, 'utf8');
    for (const action of ['--check', '--apply', '--uninstall']) {
      const r = c.install([action]);
      assert.equal(r.status, 2, `${action} ${before}`);
      assert.match(r.stdout, /何も書いていません/);
    }
    assert.equal(fs.readFileSync(c.hooksFile, 'utf8'), before);
    assert.deepEqual(c.backups(), []);
  }
});

t('a dangling symlinked hooks.json is refused, not replaced by a regular file', (c) => {
  if (process.platform === 'win32') return; // symlinks need extra rights on Windows runners
  c.mkCodexHome();
  fs.symlinkSync(path.join(c.home, 'gone', 'hooks.json'), c.hooksFile);
  const r = c.install(['--apply']);
  assert.equal(r.status, 2);
  assert.ok(fs.lstatSync(c.hooksFile).isSymbolicLink());
});

t('allow_managed_hooks_only in requirements.toml stops --apply (exit 3) unless --force; --scope project is refused', (c) => {
  c.mkCodexHome();
  const req = path.join(c.home, 'requirements.toml');
  fs.writeFileSync(req, 'allow_managed_hooks_only = true\n');
  let r = c.install(['--apply'], { env: { VL_CODEX_REQUIREMENTS: req } });
  assert.equal(r.status, 3);
  assert.equal(fs.existsSync(c.hooksFile), false);
  r = c.install(['--apply', '--force'], { env: { VL_CODEX_REQUIREMENTS: req } });
  assert.equal(r.status, 0);
  assert.equal(c.install(['--scope', 'project']).status, 2);
});

t('the installed command string really runs: a Codex-shaped git commit input writes a codex commit row', (c) => {
  c.mkCodexHome();
  c.install(['--apply']);
  const cmd = ownHandlers(c.readHooks())[0].h.command;
  const repo = new Repo();
  try {
    repo.write('a.js', '1\n');
    repo.commit('init');
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'codex', 'post-tool-use-git-commit.json'), 'utf8'));
    const r = run(cmd, [], { shell: true, cwd: repo.dir, env: repo.env, input: JSON.stringify({ ...fixture, cwd: repo.dir, tool_response: { output: repo.commitOutput } }) });
    assert.equal(r.status, 0, r.stderr);
    const row = repo.lastCommitRow();
    assert.equal(row && row.agent, 'codex');
  } finally {
    repo.cleanup();
  }
});

// --- AGENTS.md ---------------------------------------------------------------------------------

t('--agents-md appends exactly two lines, keeps the file, is idempotent, and --uninstall restores it', (c) => {
  c.mkCodexHome();
  const original = '# my rules\n\n- be nice\n';
  fs.writeFileSync(c.agentsFile, original);
  const r = c.install(['--agents-md', '--json']);
  assert.equal(r.json.changes.filter((x) => x.startsWith('AGENTS.md')).length, 2);
  assert.equal(fs.readFileSync(c.agentsFile, 'utf8'), original); // check never writes

  assert.equal(c.install(['--apply', '--agents-md']).status, 0);
  const once = fs.readFileSync(c.agentsFile, 'utf8');
  assert.ok(once.startsWith(original));
  assert.deepEqual(once.slice(original.length).split('\n').filter(Boolean), codex.agentsLines(process.execPath));
  assert.equal(c.install(['--apply', '--agents-md']).status, 0);
  assert.equal(fs.readFileSync(c.agentsFile, 'utf8'), once);

  assert.equal(c.install(['--uninstall', '--agents-md']).status, 0);
  assert.equal(fs.readFileSync(c.agentsFile, 'utf8'), original);
});

t('--agents-md writes to a non-empty AGENTS.override.md (the file Codex reads) and keeps CRLF', (c) => {
  c.mkCodexHome();
  fs.writeFileSync(c.agentsFile, 'plain\n');
  const ov = path.join(c.cx, 'AGENTS.override.md');
  fs.writeFileSync(ov, 'override\r\n');
  assert.equal(c.install(['--apply', '--agents-md']).status, 0);
  assert.equal(fs.readFileSync(c.agentsFile, 'utf8'), 'plain\n');
  const text = fs.readFileSync(ov, 'utf8');
  assert.ok(text.startsWith('override\r\n'));
  assert.equal(text.split('\r\n').filter((l) => codex.AGENTS_LINE_RE.test(l)).length, 2);
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/);
});

test("AGENTS.md snippet: two single lines, both recognisable, the second carries this machine's mark command", () => {
  const lines = codex.agentsLines('node');
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.doesNotMatch(l, /[\r\n]/);
    assert.match(l, codex.AGENTS_LINE_RE);
  }
  assert.match(lines[0], /\$verify/);
  assert.ok(lines[1].includes(`"${VL}" mark verify --agent codex`));
});

// --- repo verify skill -------------------------------------------------------------------------

t('--repo-skill: check only by default; --apply copies the template; an edited skill is never overwritten or removed', (c) => {
  c.mkCodexHome();
  const repo = new Repo();
  try {
    repo.write('a.js', '1\n');
    repo.commit('init');
    const dest = path.join(repo.dir, '.agents', 'skills', 'verify', 'SKILL.md');
    let r = c.install(['--repo-skill', '--json'], { cwd: repo.dir });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.json.changes.some((x) => x.includes('verify スキルを置く')));
    assert.equal(fs.existsSync(dest), false);

    r = c.install(['--apply', '--repo-skill'], { cwd: repo.dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(dest, 'utf8'), fs.readFileSync(TEMPLATE, 'utf8'));
    assert.equal(fs.existsSync(c.hooksFile), false); // its own unit: the user hook is not merged
    assert.equal(fs.existsSync(c.agentsFile), false);
    assert.match(repo.git('status', '--porcelain'), /\.agents\//); // copied, not committed

    fs.appendFileSync(dest, '\n- extra local step\n');
    const edited = fs.readFileSync(dest, 'utf8');
    r = c.install(['--apply', '--repo-skill'], { cwd: repo.dir });
    assert.equal(fs.readFileSync(dest, 'utf8'), edited);
    assert.match(r.stdout, /上書きしません/);
    c.install(['--uninstall', '--repo-skill'], { cwd: repo.dir });
    assert.equal(fs.readFileSync(dest, 'utf8'), edited);

    fs.copyFileSync(TEMPLATE, dest);
    c.install(['--uninstall', '--repo-skill'], { cwd: repo.dir });
    assert.equal(fs.existsSync(path.join(repo.dir, '.agents')), false);
  } finally {
    repo.cleanup();
  }
});

t('--repo-skill never touches an installed hook, works under allow_managed_hooks_only, and is not combined with --agents-md', (c) => {
  c.mkCodexHome();
  assert.equal(c.install(['--apply']).status, 0);
  const hooks = fs.readFileSync(c.hooksFile, 'utf8');
  const req = path.join(c.home, 'requirements.toml');
  fs.writeFileSync(req, 'allow_managed_hooks_only = true\n');
  const repo = new Repo();
  try {
    repo.write('a.js', '1\n');
    repo.commit('init');
    let r = c.install(['--apply', '--repo-skill'], { cwd: repo.dir, env: { VL_CODEX_REQUIREMENTS: req } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(repo.dir, '.agents', 'skills', 'verify', 'SKILL.md')));
    r = c.install(['--uninstall', '--repo-skill'], { cwd: repo.dir });
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(path.join(repo.dir, '.agents')), false);
    assert.equal(fs.readFileSync(c.hooksFile, 'utf8'), hooks);
    assert.equal(c.install(['--apply', '--repo-skill', '--agents-md'], { cwd: repo.dir }).status, 2);
  } finally {
    repo.cleanup();
  }
});

t('--repo-skill outside a git repository is an error, nothing written', (c) => {
  c.mkCodexHome();
  const dir = tmpDir('vl-norepo-');
  try {
    const r = c.install(['--apply', '--repo-skill'], { cwd: dir });
    assert.equal(r.status, 2);
    assert.equal(fs.existsSync(path.join(dir, '.agents')), false);
  } finally {
    rmrf(dir);
  }
});

test('verify skill template: valid frontmatter, ends with the mark step, not a Claude plugin skill', () => {
  const text = fs.readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(front, 'frontmatter');
  const keys = front[1].split('\n').map((l) => /^([a-z-]+):/.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.deepEqual(keys, ['name', 'description']);
  assert.match(front[1], /^name: verify$/m);
  const desc = /^description: (.+)$/m.exec(front[1])[1];
  assert.ok(desc.length > 40 && desc.length <= 1024, `description length ${desc.length}`);
  assert.doesNotMatch(desc, /[<>]/);
  const sections = text.split(/\n## /);
  assert.match(sections[sections.length - 1], /mark verify --agent codex/);
  assert.match(text, /\.claude\/skills\/verify\/SKILL\.md/); // the checks have one source
  assert.doesNotMatch(text, /vl\.js"/); // no machine-specific path in a committed file
  assert.equal(fs.existsSync(path.join(ROOT, 'skills', 'verify')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).skills, undefined);
});
