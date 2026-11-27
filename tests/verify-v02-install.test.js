'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { INSTALL, Repo, VL, run, fakeCodex, withPrependedPath } = require('./helpers');
const { splitCommand } = require('../scripts/lib/shellquote');

const foreignStop = { hooks: [{type: 'command', command: 'other-stop'}] };

function install(repo, ...args) {
  return run(process.execPath, [INSTALL, ...args], { cwd: repo.dir, env: repo.env });
}

for (const agent of ['claude', 'codex']) {
  test(`${agent} v0.2 hook install and uninstall preserve the v0.1 and unrelated hooks`, (t) => {
    const repo = new Repo();
    t.after(() => repo.cleanup());
    const base = agent === 'codex' ? repo.env.CODEX_HOME : repo.env.CLAUDE_CONFIG_DIR;
    const settings = path.join(base, agent === 'codex' ? 'hooks.json' : 'settings.json');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [foreignStop] } }));
    const configure = (...args) => {
      const result = install(repo, '--agent', agent, '--node', process.execPath, ...args);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(fs.readFileSync(settings, 'utf8')).hooks;
    };
    const original = configure('--apply');
    const config = path.join(repo.env.VL_CONFIG_DIR, 'config.json');
    const originalConfig = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : null;
    const withV2 = configure('--v02', '--apply');
    assert.equal(fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : null, originalConfig);
    assert.deepEqual(withV2.PostToolUse, original.PostToolUse);
    assert.deepEqual(withV2.Stop[0], foreignStop);
    for (const [event, sub] of [['UserPromptSubmit', 'start'], ['Stop', 'stop']]) {
      const group = withV2[event].at(-1);
      assert.equal(group.matcher, undefined);
      const [handler] = group.hooks;
      const command = handler.args ? [handler.command, ...handler.args] : splitCommand(handler.command);
      assert.deepEqual(command, [process.execPath, VL, 'hook', sub, '--agent', agent]);
    }
    assert.deepEqual(configure('--v02', '--apply'), withV2);
    assert.deepEqual(configure('--v02', '--uninstall'), original);
    assert.deepEqual(configure('--v02', '--apply'), withV2);
    const withoutV1 = configure('--uninstall');
    assert.equal(withoutV1.PostToolUse, undefined);
    assert.deepEqual(withoutV1.UserPromptSubmit, withV2.UserPromptSubmit);
    assert.deepEqual(withoutV1.Stop, withV2.Stop);
    assert.deepEqual(configure('--v02', '--uninstall'), { Stop: [foreignStop] });
  });

  test(`${agent} v0.2 skill installs and uninstalls on its own`, (t) => {
    const repo = new Repo();
    t.after(() => repo.cleanup());
    const dir = agent === 'claude' ? '.claude' : '.agents';
    const original = path.join(repo.dir, dir, 'skills', 'verify', 'SKILL.md');
    repo.write(path.join(dir, 'skills', 'verify', 'SKILL.md'), 'Existing local skill');
    const skill = path.join(repo.dir, dir, 'skills', 'verify2', 'SKILL.md');
    const args = ['--v02', '--repo-skill', '--agent', agent];
    let result = install(repo, ...args, '--check');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(skill), false);
    result = install(repo, ...args, '--apply');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const guide = fs.readFileSync(skill, 'utf8');
    for (const token of ['name: verify2', 'inputFiles', 'entryAdditionQuote', '--withdraw', 't.plan(1)']) {
      assert.ok(guide.includes(token), token);
    }
    result = install(repo, ...args, '--uninstall');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(skill), false);
    assert.equal(fs.readFileSync(original, 'utf8'), 'Existing local skill');
  });
}

test('doctor reports v0.2 tool availability and separates host hook wiring', (t) => {
  const repo = new Repo();
  t.after(() => repo.cleanup());
  const win = process.platform === 'win32';
  fs.writeFileSync(path.join(repo.home, win ? 'claude.cmd' : 'claude'),
    win ? '@echo 2.1.295' : '#!/bin/sh\necho 2.1.295\n', { mode: 0o755 });
  fs.mkdirSync(repo.env.CODEX_HOME);
  const env = { ...withPrependedPath(repo.env, repo.home), VL_CODEX_BIN: fakeCodex(repo.home) };
  for (const agent of ['claude', 'codex']) {
    const result = install(repo, '--agent', agent, '--v02', '--apply');
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  repo.write('.verify-layer.json', '{"verifyV2":{"mode":"observe","runner":"unsupported"}}');
  const result = run(process.execPath, [VL, 'doctor', '--json'], { cwd: repo.dir, env });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const lines = JSON.parse(result.stdout).results.map(({msg}) => msg).join('\n');
  for (const token of ['v0.2', 'python3', 'pytest', 'strace', 'Claude v0.2', 'Codex v0.2', 'UserPromptSubmit', 'Stop']) {
    assert.ok(lines.includes(token), token);
  }
});
