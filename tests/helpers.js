'use strict';
// Shared test helpers: isolated temp git repos and a runner for scripts/vl.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VL = path.join(ROOT, 'scripts', 'vl.js');
const INSTALL = path.join(ROOT, 'scripts', 'install.js');

function tmpDir(prefix = 'vl-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Environment that never reads the developer's real git or Claude configuration.
function isolatedEnv(extra = {}) {
  const home = extra.HOME || tmpDir('vl-home-');
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    VL_CONFIG_DIR: path.join(home, 'vl-config'),
    // Codex: never the real ~/.codex, codex binary or /etc/codex/requirements.toml.
    CODEX_HOME: path.join(home, '.codex'),
    VL_CODEX_BIN: path.join(home, 'no-codex-here'),
    VL_CODEX_REQUIREMENTS: path.join(home, 'no-requirements.toml'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '',
    ...extra,
  };
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, ...opts });
}

class Repo {
  constructor() {
    this.home = tmpDir('vl-home-');
    this.env = isolatedEnv({ HOME: this.home });
    this.dir = tmpDir('vl-repo-');
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'commit.gpgsign', 'false');
    this.sessionId = 'sess-1';
  }

  git(...args) {
    const r = run('git', args, { cwd: this.dir, env: this.env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  write(rel, content) {
    const file = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  commit(msg = 'c', env = {}) {
    this.git('add', '-A');
    const r = run('git', ['commit', '-q', '-m', msg], { cwd: this.dir, env: { ...this.env, ...env } });
    if (r.status !== 0) throw new Error(`commit failed: ${r.stderr}`);
    return this.git('rev-parse', 'HEAD');
  }

  // Runs `vl.js hook ...` with a JSON object (or raw string) on stdin.
  hook(args, input, { cwd, env } = {}) {
    const payload = typeof input === 'string' ? input : JSON.stringify({ session_id: this.sessionId, cwd: cwd || this.dir, ...input });
    const r = run(process.execPath, [VL, 'hook', ...args], { cwd: cwd || this.dir, env: { ...this.env, ...env }, input: payload });
    let json = null;
    if (r.stdout.trim()) {
      try {
        json = JSON.parse(r.stdout);
      } catch {
        json = undefined; // marks invalid JSON
      }
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  }

  verify(via = 'model', session = this.sessionId) {
    if (via === 'user') {
      return this.hook(['expand'], { session_id: session, hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'verify', command_args: '', prompt: '/verify' });
    }
    return this.hook(['skill'], { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'verify' }, tool_response: {} });
  }

  codeReview(session = this.sessionId) {
    return this.hook(['skill'], { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'code-review' }, tool_response: {} });
  }

  commitHook(command = 'git commit -m c', session = this.sessionId) {
    return this.hook(['commit'], { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: {} });
  }

  ledgerFile() {
    return path.resolve(this.dir, this.git('rev-parse', '--git-path', 'claude-verify'), 'ledger.jsonl');
  }

  ledger() {
    try {
      return fs.readFileSync(this.ledgerFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  lastCommitRow() {
    return this.ledger().filter((r) => r.kind === 'commit').pop();
  }

  config(obj) {
    fs.mkdirSync(this.env.VL_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(this.env.VL_CONFIG_DIR, 'config.json'), JSON.stringify(obj));
  }

  cleanup() {
    rmrf(this.dir);
    rmrf(this.home);
  }
}

// A stand-in `codex` command printing `codex-cli <version>` (use via VL_CODEX_BIN).
function fakeCodex(dir, version = '0.170.0') {
  const win = process.platform === 'win32';
  const bin = path.join(dir, win ? 'codex.cmd' : 'codex');
  fs.writeFileSync(bin, win ? `@echo codex-cli ${version}\r\n` : `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
  return bin;
}

module.exports = { ROOT, VL, INSTALL, Repo, tmpDir, rmrf, isolatedEnv, run, fakeCodex };
