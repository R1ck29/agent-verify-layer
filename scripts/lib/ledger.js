'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { gitPath } = require('./git');

const LEDGER_VERSION = 1;

function ledgerDir(cwd) {
  return gitPath(cwd, 'claude-verify');
}

function ledgerFile(cwd) {
  const d = ledgerDir(cwd);
  return d ? path.join(d, 'ledger.jsonl') : null;
}

// Rows only ever carry counts, hashes, ids and timestamps: never prompts,
// command arguments, commands or file names.
function append(cwd, row) {
  const file = ledgerFile(cwd);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ v: LEDGER_VERSION, ...row }) + '\n');
    return true;
  } catch {
    return false; // read-only .git, disk full, ...: a hook must never fail the user's work
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function deadOwner(lock, hostname) {
  const files = fs.readdirSync(lock);
  if (files.length !== 1) return null;
  const match = /^owner-(\d+)-[a-f0-9-]{36}$/.exec(files[0]);
  const pid = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const file = path.join(lock, files[0]);
  if (!fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8') !== hostname) return null;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code === 'ESRCH') return file;
  }
  return null;
}

function removeLock(lock, owner) {
  // Only the process that unlinks this acquisition's unique marker may remove its directory.
  fs.unlinkSync(owner);
  fs.rmdirSync(lock);
}

// An atomic directory creation keeps the SHA check and append together across hook processes.
// For an old lock, only a confirmed dead local owner can be cleaned up.
// Returns { locked: false } when the lock could not be had (the caller records nothing).
function withLock(cwd, fn, { waitMs = Number(process.env.VL_LOCK_WAIT_MS) || 2500, staleMs = 15000 } = {}) {
  const wait = Number.isFinite(waitMs) ? Math.max(0, waitMs) : 2500;
  const dir = ledgerDir(cwd);
  if (!dir) return { locked: false };
  const lock = path.join(dir, 'ledger.lock');
  const hostname = os.hostname();
  const owner = path.join(lock, `owner-${process.pid}-${randomUUID()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { locked: false };
  }
  const deadline = performance.now() + wait;
  for (;;) {
    if (performance.now() >= deadline) return { locked: false };
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') return { locked: false };
      try {
        const current = fs.lstatSync(lock);
        if (!current.isDirectory()) return { locked: false };
        if (Date.now() - current.mtimeMs > staleMs) {
          const staleOwner = deadOwner(lock, hostname);
          if (staleOwner) {
            removeLock(lock, staleOwner);
            continue;
          }
        }
      } catch (inspectionError) {
        if (inspectionError.code === 'ENOENT') continue;
        return { locked: false };
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { locked: false };
      sleepMs(Math.min(remaining, 10 + Math.floor(Math.random() * 15)));
    }
  }
  try {
    fs.writeFileSync(owner, hostname, { flag: 'wx' });
  } catch {
    try {
      fs.rmSync(owner, { force: true });
      fs.rmdirSync(lock);
    } catch {
      /* The acquisition failed and no callback ran. */
    }
    return { locked: false };
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    try {
      removeLock(lock, owner);
    } catch {
      /* already gone */
    }
  }
}

function readAll(cwd) {
  const file = ledgerFile(cwd);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object') rows.push(r);
    } catch {
      /* skip a damaged line */
    }
  }
  return rows;
}

module.exports = { LEDGER_VERSION, ledgerDir, ledgerFile, append, readAll, withLock };
