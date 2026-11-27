'use strict';
// Minimal glob matcher (no dependencies). Paths are always compared with "/" separators.

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRe(ch) {
  return ch.replace(/[.+^$()|[\]\\{}*?]/g, '\\$&');
}

// Supports: ** (any depth), * (no "/"), ? (one char, no "/"), {a,b}.
// A glob without "/" matches the basename at any depth (like .gitignore).
function toRegExp(glob) {
  const g = normalizePath(glob);
  const anywhere = !g.includes('/');
  let re = '';
  let braceDepth = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      braceDepth++;
      re += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
    } else if (c === ',' && braceDepth > 0) {
      re += '|';
    } else {
      re += escapeRe(c);
    }
  }
  while (braceDepth-- > 0) re += ')';
  return new RegExp('^' + (anywhere ? '(?:.*/)?' : '') + re + '$');
}

const cache = new Map();
function matchGlob(glob, path) {
  let re = cache.get(glob);
  if (!re) {
    re = toRegExp(glob);
    cache.set(glob, re);
  }
  return re.test(normalizePath(path));
}

function matchAny(globs, path) {
  return globs.some((g) => matchGlob(g, path));
}

module.exports = { normalizePath, toRegExp, matchGlob, matchAny };
