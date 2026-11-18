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

module.exports = { LEDGER_VERSION, ledgerDir, ledgerFile, append, readAll };
