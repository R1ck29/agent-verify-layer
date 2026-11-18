'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_TIMEOUT = 8000;

function git(args, opts = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: opts.cwd,
    input: opts.input,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: opts.timeout || DEFAULT_TIMEOUT,
    windowsHide: true,
  });
  return {
    ok: r.status === 0 && !r.error,
    out: r.stdout || '',
    err: r.stderr || '',
    status: r.status,
    error: r.error || null,
  };
}

function splitZ(s) {
  return s.split('\0').filter(Boolean);
}

function repoRoot(cwd, opts) {
  const r = git(['rev-parse', '--show-toplevel'], { cwd, ...opts });
  return r.ok && r.out.trim() ? path.resolve(r.out.trim()) : null;
}

function gitPath(cwd, name, opts) {
  const r = git(['rev-parse', '--git-path', name], { cwd, ...opts });
  return r.ok && r.out.trim() ? path.resolve(cwd, r.out.trim()) : null;
}

function hasHead(cwd, opts) {
  return git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd, ...opts }).ok;
}

function headInfo(cwd, opts) {
  const r = git(['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd, ...opts });
  if (!r.ok || !r.out.trim()) return null;
  const [sha, ...parents] = r.out.trim().split(/\s+/);
  const t = git(['log', '-1', '--format=%ct', 'HEAD'], { cwd, ...opts });
  const time = t.ok ? Number(t.out.trim()) : NaN;
  return { sha, parents, time: Number.isFinite(time) ? time : null };
}

// Files touched by HEAD (first parent for merges, empty tree for the root commit).
function commitPaths(cwd, head, opts) {
  const r = head.parents.length
    ? git(['diff', '--name-only', '--no-renames', '-z', head.parents[0], 'HEAD'], { cwd, ...opts })
    : git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '--no-renames', '-z', 'HEAD'], { cwd, ...opts });
  return r.ok ? splitZ(r.out) : null;
}

// Tree hash of the working tree (tracked + untracked, honouring .gitignore).
// Works on a copy of the real index so the real index and index.lock are never touched.
function treeHash(cwd, opts) {
  const idx = gitPath(cwd, 'index', opts);
  const tmp = path.join(os.tmpdir(), `vl-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    if (idx) {
      try {
        fs.copyFileSync(idx, tmp);
        // Keep the original index mtime (minus 2 us): git decides "racily clean" entries by
        // comparing file mtimes with the index mtime. A fresh mtime on the copy would make a
        // file edited right after the last index write look unchanged and give a stale tree.
        const st = fs.statSync(idx, { bigint: true });
        const sec = Number(st.mtimeNs / 1000n) / 1e6 - 0.000002;
        fs.utimesSync(tmp, sec, sec);
      } catch {
        /* no index yet: start from an empty one */
      }
    }
    const env = { GIT_INDEX_FILE: tmp };
    git(['add', '-A'], { cwd, env, ...opts });
    const r = git(['write-tree'], { cwd, env, ...opts });
    return r.ok ? r.out.trim() : null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
}

// Set of paths that differ between a tree and HEAD; null when the tree is unreachable.
function diffTreeToHead(cwd, tree, opts) {
  const r = git(['diff', '--name-only', '--no-renames', '-z', tree, 'HEAD'], { cwd, ...opts });
  return r.ok ? new Set(splitZ(r.out)) : null;
}

module.exports = {
  git,
  splitZ,
  repoRoot,
  gitPath,
  hasHead,
  headInfo,
  commitPaths,
  treeHash,
  diffTreeToHead,
};
