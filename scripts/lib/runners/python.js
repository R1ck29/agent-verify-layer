'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function environment(home) {
  const env = {
    PATH: process.env.PATH || process.env.Path,
    HOME: home, TMPDIR: home, LC_ALL: 'C.UTF-8',
  };
  // Windows child processes need these; a PATH-only env often fails to start.
  if (process.platform === 'win32') {
    for (const key of ['PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'USERPROFILE']) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

function invoke(runner, action, { root, caseData, config = {}, timeoutMs = 30000, tests } = {}) {
  const fallback = action === 'case' ? { status: 'error' } : { ok: false, tests: [] };
  let work;
  try {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-python-runner-'));
    if (action === 'available') {
      return spawnSync('python3', ['-I', '-B', '-c', 'import pytest'], {
        cwd: work, env: environment(work), timeout: timeoutMs, stdio: 'ignore',
      }).status === 0;
    }
    const copy = fs.realpathSync(root);
    const relative = path.relative(copy, fs.realpathSync(work));
    if (relative === '' || (!path.isAbsolute(relative) && !relative.startsWith('..' + path.sep))) {
      return { ...fallback, reason: 'Python runner state must reside outside the copy' };
    }
    const manifest = path.join(work, 'manifest.json');
    const evidence = path.join(work, 'evidence.json');
    fs.writeFileSync(manifest, JSON.stringify({ runner, action, caseData, config, tests }), { mode: 0o600 });
    const child = spawnSync(
      'python3', ['-I', '-B', path.join(__dirname, 'python-runner.py'), manifest, evidence], {
        cwd: copy, env: environment(work), timeout: timeoutMs, stdio: 'ignore',
      },
    );
    if (child.status !== 0) return { ...fallback, reason: child.error?.code || 'Python runner did not finish' };
    if (fs.statSync(evidence).size > 16 * 1024 * 1024) return { ...fallback, reason: 'Python runner evidence is too large' };
    const result = JSON.parse(fs.readFileSync(evidence, 'utf8'));
    if (!result || typeof result !== 'object') return fallback;
    return result;
  } catch (error) {
    return action === 'available' ? false : { ...fallback, reason: error.code || 'Invalid Python runner evidence' };
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}

function adapter(runner) {
  return {
    runCase: options => invoke(runner, 'case', options),
    runSuite: options => invoke(runner, 'suite', options),
    collectSuite: options => invoke(runner, 'collect', options),
  };
}

module.exports = { adapter, invoke };
