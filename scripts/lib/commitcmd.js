'use strict';
// Locates a single recognizable git commit in a simple shell command. Git's output must
// independently identify the resulting SHA before the hook records it.
const path = require('node:path');

// Split simple commands, retaining the operator that connected each command to its predecessor.
function segments(cmd, posix) {
  const segs = [];
  let words = [];
  let cur = '';
  let has = false;
  let op = null;
  const endWord = () => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  const endSeg = (nextOp) => {
    endWord();
    if (words.length) {
      segs.push({ words, op });
      words = [];
      op = nextOp;
    }
  };
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      cur += s.slice(i + 1, j);
      has = true;
      i = j;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (/[$`]/.test(s[j]) || (!posix && /[%!^]/.test(s[j]))) return null;
        j += posix && s[j] === '\\' ? 2 : 1;
      }
      if (j >= s.length) return null;
      // POSIX shells unescape \" \\ \$ \` inside double quotes; on Windows a backslash is a path separator.
      cur += posix ? s.slice(i + 1, j).replace(/\\(["\\$`])/g, '$1') : s.slice(i + 1, j);
      has = true;
      i = j;
    } else if (posix && ch === '\\') {
      if (++i >= s.length) return null;
      if (s[i] !== '\n') {
        cur += s[i];
        has = true;
      }
    } else if (ch === '#' && !has) {
      while (i < s.length && s[i] !== '\n') i++; // comment to end of line
      endSeg(';');
    } else if (/\s/.test(ch)) {
      if (ch === '\n') endSeg(';');
      else endWord();
    } else if (ch === '&' || ch === '|' || ch === ';') {
      if (ch === ';') endSeg(';');
      else {
        if (s[i + 1] !== ch) return null; // pipeline or background execution
        i++;
        endSeg(ch + ch);
      }
    } else if (/[()<>{}$`]/.test(ch) || (!posix && /[%!^]/.test(ch))) {
      return null; // substitutions, redirection, compound commands or Windows expansions
    } else {
      cur += ch;
      has = true;
    }
  }
  endSeg();
  return segs;
}

const NO_ARG_GLOBALS = new Set(['--no-pager', '-p', '--paginate', '--no-optional-locks', '--literal-pathspecs', '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs']);
const SAFE_CONFIG = /^(?:user\.(?:name|email)|commit\.gpgsign)=/i;
const SUPPORT_COMMANDS = new Set(['add', 'push', 'status']);

function literalDir(base, p) {
  if (!p || /[$`*?\[\]]/.test(p) || /^[-~]/.test(p)) return null;
  return path.resolve(base, p);
}

// Only a single candidate is eligible. Known branch outcomes are respected, and shell
// constructs that could change the candidate's location or supply ambiguous output are declined.
function analyzeCommit(command, cwd, posix = process.platform !== 'win32') {
  const parts = segments(command, posix);
  if (!parts) return { unsupported: true };
  let dir = path.resolve(cwd);
  let found = null;
  let previous = null;
  let moved = false;
  for (const { words, op } of parts) {
    if ((op === '&&' && previous === false) || (op === '||' && previous === true)) continue;
    if ((op === '||' && previous === null) || (moved && op !== '&&')) return { unsupported: true };
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
      if (/^(?:GIT_|PATH=|CDPATH=)/i.test(words[i])) return { unsupported: true };
      i++;
    }
    const head = words[i];
    if ((head === 'true' || head === ':' || head === 'false') && i === 0 && words.length === 1 && posix) {
      if (head === 'false') previous = false;
      else if (op !== '&&' || previous !== null) previous = true;
      continue;
    }
    if (head === 'cd') {
      const next = literalDir(dir, words[i + 1]);
      if (!next || i !== 0 || words.length !== 2 || found || op === '||') return { unsupported: true };
      dir = next;
      moved = true;
      previous = null;
      continue;
    }
    if (!head || !/^(?:.*[\\/])?git(?:\.exe)?$/i.test(head)) {
      if (parts.length > 1) return { unsupported: true };
      return null;
    }
    let gitDir = dir;
    let j = i + 1;
    let unsupported = false;
    for (; j < words.length; j++) {
      const w = words[j];
      if (w === '-C') {
        const next = literalDir(gitDir, words[++j]);
        if (!next) unsupported = true;
        else gitDir = next;
      } else if (w === '-c') {
        if (!SAFE_CONFIG.test(words[++j] || '')) unsupported = true;
      } else if (/^--(git-dir|work-tree|super-prefix|exec-path|namespace|config-env|bare|no-replace-objects)(=|$)/.test(w)) {
        unsupported = true;
        if (!w.includes('=')) j++;
      } else if (NO_ARG_GLOBALS.has(w)) continue;
      else break;
    }
    previous = null;
    if (unsupported) return { unsupported: true };
    if (words[j] !== 'commit') {
      if (parts.length > 1 && !SUPPORT_COMMANDS.has(words[j])) return { unsupported: true };
      continue;
    }
    const rest = words.slice(j + 1);
    if (rest.some((w) => ['--dry-run', '--short', '--porcelain', '--long', '-q', '--quiet', '-h', '--help'].includes(w))) continue;
    if (found) return { unsupported: true };
    found = { dir: gitDir };
  }
  return found;
}

module.exports = { analyzeCommit };
