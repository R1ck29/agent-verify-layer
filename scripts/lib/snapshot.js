'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { git, scrubbedEnv, splitZ } = require('./git');
const { requestPath, writePrivateJson } = require('./ledger');

const hash = (data) => createHash('sha256').update(data).digest('hex');
const requestPattern = /^[a-z][a-z0-9_]{7,31}$/;

function within(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function repoPath(rel) {
  if (typeof rel !== 'string' || rel.includes('\\') || rel.includes('\0') ||
      rel.split('/').some((part) => !part || ['.', '..', '.git'].includes(part))) {
    throw new Error('Invalid repository-relative path');
  }
  return rel;
}

function ignoredCache(rel) {
  return rel.split('/').some((part) => ['__pycache__', 'node_modules', '.pytest_cache'].includes(part)) ||
    /\.py[co]$/.test(rel);
}

function checkedPath(root, rel) {
  const target = path.join(root, repoPath(rel));
  let parent = path.dirname(target);
  while (parent !== root) {
    const st = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) throw new Error(`Non-directory path component: ${rel}`);
    parent = path.dirname(parent);
  }
  return target;
}

function stableStat(file, read) {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const fd = fs.openSync(file, flags);
  try {
    const first = fs.fstatSync(fd, { bigint: true });
    if (!first.isFile()) throw new Error('Snapshot entry is no longer a regular file');
    const data = read(fd);
    const last = fs.fstatSync(fd, { bigint: true });
    if (first.ctimeNs !== last.ctimeNs || first.size !== last.size || first.mtimeNs !== last.mtimeNs) {
      throw new Error('File changed during snapshot capture');
    }
    return { data, mode: Number(first.mode) & 0o777 };
  } finally {
    fs.closeSync(fd);
  }
}

function identity(files, directories, dependencyId) {
  const entries = Object.keys(files).sort().map((rel) => {
    const entry = files[rel];
    return [rel, entry.kind, entry.mode, entry.hash ?? entry.target];
  });
  return hash(JSON.stringify([entries, Object.entries(directories).sort(), dependencyId]));
}

function capture(repo, { includePaths = [], nodeDependencies = false } = {}) {
  if (process.platform !== 'linux') throw new Error('Verify v0.2 snapshots require Linux');
  const root = fs.realpathSync(repo);
  const result = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    fullEnv: scrubbedEnv(),
  });
  if (!result.ok || result.out.includes('\ufffd')) throw new Error('Could not enumerate working tree paths');
  const files = Object.create(null);
  const directories = Object.create(null);
  const names = new Set(splitZ(result.out));
  const explicit = new Set();

  function recordParents(rel) {
    let parent = path.posix.dirname(rel);
    while (parent !== '.') {
      directories[parent] ??= fs.lstatSync(path.join(root, parent)).mode & 0o777;
      parent = path.posix.dirname(parent);
    }
  }

  function include(rel) {
    if (rel.split('/').some((part) => part === '__pycache__') || /\.py[co]$/.test(rel)) {
      throw new Error(`Cannot include generated Python bytecode: ${rel}`);
    }
    const file = checkedPath(root, rel);
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const child of fs.readdirSync(file)) include(`${rel}/${child}`);
      directories[rel] = st.mode & 0o777;
      recordParents(rel);
    } else {
      names.add(rel);
      explicit.add(rel);
    }
  }

  for (const rel of includePaths) include(rel);
  for (const rel of [...names].sort()) {
    if (ignoredCache(rel) && !explicit.has(rel)) continue;
    const file = checkedPath(root, rel);
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) {
      const link = path.resolve(path.dirname(file), fs.readlinkSync(file));
      if (!within(root, link)) throw new Error(`Symlink points outside the repository: ${rel}`);
      const target = link === root ? '.' : repoPath(path.relative(root, link));
      if (ignoredCache(target)) throw new Error(`Symlink points to an excluded path: ${rel}`);
      try {
        if (!within(root, fs.realpathSync(link))) throw new Error(`Symlink resolves outside the repository: ${rel}`);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      files[rel] = { kind: 'symlink', mode: st.mode & 0o777, target };
    } else if (st.isFile()) {
      const { data, mode } = stableStat(file, fs.readFileSync);
      files[rel] = { kind: 'file', mode, hash: hash(data), data };
    } else {
      throw new Error(`Unsupported snapshot entry (including nested Git repositories): ${rel}`);
    }
    recordParents(rel);
  }
  const dependencyId = nodeDependencies ? dependencyTree(root, null, 512 * 1024 * 1024) : null;
  return { id: identity(files, directories, dependencyId), files, directories, dependencyId };
}

function removeCopy(dir) {
  function writable(file) {
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st?.isDirectory()) return;
    fs.chmodSync(file, (st.mode & 0o777) | 0o700);
    for (const child of fs.readdirSync(file)) writable(path.join(file, child));
  }
  writable(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

function dependencyTree(repo, root, limit) {
  const base = path.join(repo, 'node_modules');
  const initial = fs.lstatSync(base, { throwIfNoEntry: false });
  if (!initial) return null;
  if (!initial.isDirectory()) throw new Error('Cannot isolate node_modules');
  let bytes = 0;
  const manifest = createHash('sha256');
  const add = (...entry) => manifest.update(JSON.stringify(entry) + '\n');

  function copy(source) {
    const relative = path.relative(repo, source);
    const out = root && path.join(root, relative);
    const st = fs.lstatSync(source);
    if (st.isDirectory()) {
      if (out) fs.mkdirSync(out);
      add(relative, 'directory', st.mode & 0o777);
      for (const name of fs.readdirSync(source).sort()) copy(path.join(source, name));
      if (out) fs.chmodSync(out, (st.mode & 0o555) | 0o500);
      return;
    }
    if (st.isSymbolicLink()) {
      const destination = fs.realpathSync(source);
      if (!within(repo, destination) || destination === repo) {
        throw new Error('Dependency symlink points outside the isolated paths');
      }
      const rel = repoPath(path.relative(repo, destination));
      add(relative, 'link', rel);
      if (out) {
        const target = path.join(root, rel);
        if (!within(base, destination) && !fs.existsSync(target)) {
          throw new Error('Workspace link target is absent in this snapshot');
        }
        fs.symlinkSync(path.relative(path.dirname(out), target), out);
      }
      return;
    }
    if (!st.isFile()) throw new Error('Unsupported Node dependency entry');
    bytes += st.size;
    if (bytes > limit) throw new Error('Node dependency size exceeds the isolation limit');
    const contents = stableStat(source, (fd) => {
      if (!out) return fs.readFileSync(fd);
      fs.copyFileSync(source, out, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
      return fs.readFileSync(out);
    });
    add(relative, 'file', contents.mode, hash(contents.data));
    if (out) fs.chmodSync(out, contents.mode & 0o555);
  }

  copy(base);
  return manifest.digest('hex');
}

function materialize(repo, id, snapshot, {
  overlay = {}, omit = [], nodeDependencies = false, dependencyLimit = 512 * 1024 * 1024,
} = {}) {
  if (process.platform !== 'linux' || !requestPattern.test(id)) throw new Error('Invalid snapshot expansion');
  const tmp = fs.realpathSync(os.tmpdir());
  const source = fs.realpathSync(repo);
  if (within(source, tmp)) throw new Error('Temporary directory must be outside the repository');
  const root = fs.mkdtempSync(path.join(tmp, `vl-${id}-`));
  const cleanup = () => removeCopy(root);
  try {
    const entries = { ...snapshot.files, ...overlay };
    for (const rel of omit) delete entries[rel];
    const isDependency = (rel) => nodeDependencies && (rel === 'node_modules' || rel.startsWith('node_modules/'));
    const dirs = Object.entries(snapshot.directories).filter(([rel]) => !isDependency(rel));
    for (const [rel] of dirs) fs.mkdirSync(checkedPath(root, rel), { recursive: true });
    for (const [rel, entry] of Object.entries(entries)) {
      if (isDependency(rel)) continue;
      const out = checkedPath(root, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      if (entry.kind === 'symlink') {
        const target = entry.target === '.' ? root : path.join(root, repoPath(entry.target));
        fs.symlinkSync(path.relative(path.dirname(out), target) || '.', out);
      } else {
        fs.writeFileSync(out, entry.data, { flag: 'wx', mode: 0o600 });
        fs.chmodSync(out, entry.mode);
      }
    }
    for (const [rel, mode] of dirs.sort(([a], [b]) => b.length - a.length)) {
      fs.chmodSync(path.join(root, rel), mode);
    }
    if (nodeDependencies && dependencyTree(source, root, dependencyLimit) !== snapshot.dependencyId) {
      throw new Error('Node dependency tree changed since the snapshot');
    }
    return { root, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function persistSnapshot(repo, id, snapshot) {
  const files = Object.fromEntries(Object.entries(snapshot.files).map(([rel, entry]) => [
    rel, entry.kind === 'file' ? { ...entry, data: entry.data.toString('base64') } : entry,
  ]));
  writePrivateJson(requestPath(repo, id + '.snapshot.json'), { ...snapshot, files });
}

function readSnapshot(repo, id) {
  const saved = JSON.parse(fs.readFileSync(requestPath(repo, id + '.snapshot.json'), 'utf8'));
  const files = Object.assign(Object.create(null), saved.files);
  const directories = Object.assign(Object.create(null), saved.directories);
  for (const [rel, entry] of Object.entries(files)) {
    repoPath(rel);
    if (entry.kind === 'file') {
      entry.data = Buffer.from(entry.data, 'base64');
      if (hash(entry.data) !== entry.hash) throw new Error('Corrupt snapshot file contents');
    } else if (entry.kind === 'symlink') {
      if (entry.target !== '.') repoPath(entry.target);
    } else {
      throw new Error('Invalid snapshot entry');
    }
  }
  if (identity(files, directories, saved.dependencyId) !== saved.id) throw new Error('Corrupt snapshot manifest');
  return { id: saved.id, files, directories, dependencyId: saved.dependencyId };
}

module.exports = { capture, materialize, persistSnapshot, readSnapshot, repoPath, within, hash, requestPattern };
