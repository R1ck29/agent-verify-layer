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
    // opts.fullEnv replaces process.env entirely (see isolatedGitEnv); otherwise opts.env is merged.
    env: { ...(opts.fullEnv || process.env), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) },
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

// Variables that point git at a repository, object store or config other than the one in cwd.
const REPO_VARS = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|QUARANTINE_PATH|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|REPLACE_REF_BASE|SHALLOW_FILE|GRAFT_FILE)$/;

// An environment for running git in a throw-away repository that cannot reach the caller's
// repository, config or hooks (doctor's smoke test). Pass it as { fullEnv } so nothing inherited
// is mixed back in. `hooksDir` must be an empty directory; pass an empty file as `globalConfig` on
// Windows (\\.\nul is not a readable config there).
function isolatedGitEnv(base, hooksDir, globalConfig = os.devNull) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!REPO_VARS.test(k)) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig, // an empty file: git on Windows cannot read os.devNull as a config
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooksDir,
    GIT_CONFIG_KEY_1: 'commit.gpgsign',
    GIT_CONFIG_VALUE_1: 'false',
  };
}

// process.env without the variables that redirect git to another repository, object store or
// config (for read-only questions about the repository in cwd: is it ignored, where is its root).
function scrubbedEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!REPO_VARS.test(k)) env[k] = v;
  return env;
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

// The two newest HEAD reflog entries: [{ sha, ts, subject }] (newest first). A commit made by
// `git commit` leaves a "commit…" entry; reading commands leave none. null when there is no reflog.
function reflog(cwd, opts) {
  const r = git(['reflog', '-2', '--date=unix', '--format=%H%x09%gd%x09%gs', 'HEAD'], { cwd, ...opts });
  if (!r.ok) return null;
  const rows = r.out.split('\n').filter(Boolean).map((l) => {
    const [sha, gd, subject] = l.split('\t');
    const m = /@\{(\d+)\}/.exec(gd || '');
    return { sha, ts: m ? Number(m[1]) : null, subject: subject || '' };
  });
  return rows.length ? rows : null;
}

function headTree(cwd, opts) {
  const r = git(['rev-parse', '--verify', '-q', 'HEAD^{tree}'], { cwd, ...opts });
  return r.ok ? r.out.trim() : null;
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
  if (!idx) return null;
  const tmp = path.join(os.tmpdir(), `vl-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    // Only an absent index can start empty. lstat keeps a dangling symlink in the read-error path.
    if (fs.lstatSync(idx, { throwIfNoEntry: false })) {
      fs.copyFileSync(idx, tmp);
      // Preserve the original index mtime (minus 2 us) for Git's "racily clean" check.
      const st = fs.statSync(idx, { bigint: true });
      const sec = Number(st.mtimeNs / 1000n) / 1e6 - 0.000002;
      fs.utimesSync(tmp, sec, sec);
    }
    const snapshotOpts = { cwd, ...opts, env: { ...opts?.env, GIT_INDEX_FILE: tmp } };
    // Snapshot-only git: no repository hooks (post-index-change). A failed `add -A` (e.g. an
    // untracked repository without commits inside the tree) must not fall through to
    // write-tree, which would succeed and return the tree of the OLD index.
    const add = git(['-c', `core.hooksPath=${os.devNull}`, 'add', '-A'], snapshotOpts);
    if (!add.ok) return null;
    const r = git(['write-tree'], snapshotOpts);
    return r.ok ? r.out.trim() : null;
  } catch {
    return null;
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
  isolatedGitEnv,
  scrubbedEnv,
  splitZ,
  repoRoot,
  gitPath,
  hasHead,
  headInfo,
  commitPaths,
  reflog,
  headTree,
  treeHash,
  diffTreeToHead,
};
