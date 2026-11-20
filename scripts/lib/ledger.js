'use strict';
const fs = require('node:fs');
const path = require('node:path');
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

// Runs fn while holding the ledger's lock (an atomically created directory), so "is this SHA
// already recorded?" and "record it" cannot interleave across hook processes. The wait is bounded
// and a lock older than staleMs (crashed holder) is taken over: a hook never holds up a commit.
// Returns { locked: false } when the lock could not be had (the caller records nothing).
function withLock(cwd, fn, { waitMs, staleMs = 15000 } = {}) {
  const wait = waitMs !== undefined ? waitMs : Number(process.env.VL_LOCK_WAIT_MS) || 2500;
  const dir = ledgerDir(cwd);
  if (!dir) return { locked: false };
  const lock = path.join(dir, 'ledger.lock');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { locked: false };
  }
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') return { locked: false };
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch {
        continue; // vanished between the checks: try to take it
      }
      if (Date.now() - t0 > wait) return { locked: false };
      sleepMs(10 + Math.floor(Math.random() * 15));
    }
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    try {
      fs.rmdirSync(lock);
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
