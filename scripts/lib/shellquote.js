'use strict';
// Quoting for command strings that an agent runs through a shell (Codex hook `command`, the mark
// line in AGENTS.md and in the verify context). A path must reach the shell as ONE literal word:
// `$HOME` or a backtick inside it must never be expanded. What a shell cannot express safely is
// refused (throws) so callers can stop before writing anything.

const bad = (s) => new Error(`パスに使えない文字があります: ${JSON.stringify(s)}`);

// always: quote even when not needed (script paths). Windows shells (cmd, PowerShell) only get
// double quotes; `$`, backtick and `%` would still be expanded inside them, so they are refused.
function quoteArg(s, { platform = process.platform, always = false } = {}) {
  if (typeof s !== 'string' || !s || /[\0\r\n]/.test(s)) throw bad(s);
  if (platform === 'win32') {
    if (/["$`%]/.test(s)) throw bad(s);
    return always || /[\s&()^;,'!=]/.test(s) ? `"${s}"` : s;
  }
  if (!always && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  // Double quotes are safe unless the text has $ ` " or a backslash that could escape something.
  if (!/[$`"]|\\\\|\\$/.test(s)) return `"${s}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Inverse of quoteArg for the shapes it writes: words separated by blanks, '…' literal, "…"
// literal (backslashes stay as written: Windows paths), and \' outside quotes. null if unbalanced.
function splitCommand(cmd) {
  const out = [];
  let cur = '';
  let has = false;
  let i = 0;
  const s = String(cmd);
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      cur += s.slice(i + 1, j);
      has = true;
      i = j + 1;
    } else if (ch === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) return null;
      cur += s.slice(i + 1, j);
      has = true;
      i = j + 1;
    } else if (ch === '\\' && s[i + 1] === "'") {
      cur += "'";
      has = true;
      i += 2;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      i++;
    } else {
      cur += ch;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

module.exports = { quoteArg, splitCommand };
