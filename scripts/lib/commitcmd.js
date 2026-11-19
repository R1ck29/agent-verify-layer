'use strict';
// Reads the text of a shell command to find out WHERE a `git commit` ran, so the hook records the
// commit that command made and nothing else. Only the command's shape is read; nothing from it is
// stored. Understands: `&&` `||` `;` `|` `&` newline as separators, quotes, leading VAR=value,
// `git [-C dir] [-c k=v] [--no-pager ...] commit`, and `cd dir` before it. Anything that changes the
// repository in a way we cannot follow (--git-dir, --work-tree, GIT_DIR=..., `cd $VAR`) is
// `unsupported`: not recorded (the report counts such commits as not captured).
const os = require('node:os');
const path = require('node:path');

// Splits into segments of words. Quoted text stays inside its word; separators inside quotes are text.
function segments(cmd, posix = process.platform !== 'win32') {
  const segs = [];
  let words = [];
  let cur = '';
  let has = false;
  const endWord = () => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length) segs.push(words);
    words = [];
  };
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j < 0 ? s.length : j;
      cur += s.slice(i + 1, end);
      has = true;
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += posix && s[j] === '\\' ? 2 : 1;
      // POSIX shells unescape \" \\ \$ \` inside double quotes; on Windows a backslash is a path separator.
      cur += posix ? s.slice(i + 1, j).replace(/\\(["\\$`])/g, '$1') : s.slice(i + 1, j);
      has = true;
      i = j;
    } else if (posix && ch === '\\' && i + 1 < s.length && s[i + 1] !== '\n') {
      cur += s[++i];
      has = true;
    } else if (ch === '#' && !has) {
      while (i < s.length && s[i] !== '\n') i++; // comment to end of line
      endSeg();
    } else if (/\s/.test(ch)) {
      if (ch === '\n') endSeg();
      else endWord();
    } else if (ch === '&' || ch === '|' || ch === ';') {
      if ((ch === '&' || ch === '|') && s[i + 1] === ch) i++;
      endSeg();
    } else {
      cur += ch;
      has = true;
    }
  }
  endSeg();
  return segs;
}

const NO_ARG_GLOBALS = new Set(['--no-pager', '-p', '--paginate', '--no-optional-locks', '--literal-pathspecs', '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--bare', '--no-replace-objects']);
const REPO_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|NAMESPACE)=/;

function literalDir(base, p) {
  if (!p || /[$`*?]/.test(p) || p === '-') return null;
  const expanded = p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
  if (expanded.startsWith('~')) return null;
  return path.resolve(base, expanded);
}

// -> { dir } for the last real `git commit` in the command, null when there is none (read-only
// commands, --dry-run, other sub-commands), or { unsupported: true } when it cannot be placed.
function analyzeCommit(command, cwd, posix = process.platform !== 'win32') {
  let dir = path.resolve(cwd);
  let found = null;
  for (const words of segments(command, posix)) {
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
      if (REPO_ENV.test(words[i])) return { unsupported: true };
      i++;
    }
    const head = words[i];
    if (head === undefined) continue;
    if (head === 'cd' || head === 'pushd') {
      const next = literalDir(dir, words[i + 1]);
      if (!next) return { unsupported: true };
      dir = next;
      continue;
    }
    if (!/^(?:.*[\\/])?git(?:\.exe)?$/i.test(head)) continue;
    let gitDir = dir;
    let j = i + 1;
    let unsupported = false;
    for (; j < words.length; j++) {
      const w = words[j];
      if (w === '-C') {
        const next = literalDir(gitDir, words[++j]);
        if (!next) unsupported = true;
        else gitDir = next;
      } else if (w === '-c' || w === '--exec-path' || w === '--namespace') j++;
      else if (/^--(git-dir|work-tree|super-prefix|exec-path|namespace)(=|$)/.test(w)) {
        if (/^--(git-dir|work-tree)/.test(w)) unsupported = true;
        if (!w.includes('=')) j++;
      } else if (NO_ARG_GLOBALS.has(w) || /^--[a-z-]+=/.test(w) || w.startsWith('--')) continue;
      else break;
    }
    if (words[j] !== 'commit') continue;
    const rest = words.slice(j + 1);
    if (rest.some((w) => w === '--dry-run' || w === '-h' || w === '--help')) continue;
    found = unsupported ? { unsupported: true } : { dir: gitDir };
  }
  return found;
}

module.exports = { analyzeCommit, segments };
