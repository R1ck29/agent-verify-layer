import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Worker, isMainThread } from 'node:worker_threads';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import values from './node-values.js';

const { serializeInput } = values;

if (isMainThread && process.env.NODE_TEST_CONTEXT === 'child-v8' && process.env.VL_NODE_CAPTURE) {
  await install();
}

function resolvedPath(value) {
  if (typeof value === 'string') return path.resolve(value);
  if (Buffer.isBuffer(value)) return path.resolve(value.toString());
  if (value instanceof URL && value.protocol === 'file:') return fileURLToPath(value);
  return null;
}

async function install() {
  const captureFile = process.env.VL_NODE_CAPTURE;
  delete process.env.VL_NODE_CAPTURE;
  const readFile = fs.readFileSync;
  const writeFile = fs.writeFileSync;
  const realpath = fs.realpathSync;
  const lstat = fs.lstatSync;
  const { root, testFile, output, shape } = JSON.parse(readFile(captureFile, 'utf8'));
  const testUrl = pathToFileURL(testFile).href;
  const stateKey = `vl_evidence_${randomBytes(16).toString('hex')}`;
  const state = { assertions: [], inputs: [], references: [], exceptions: [], problems: [], childStarted: false };
  const copyFiles = new Set();
  const seenExceptions = new WeakSet();

  function relative(file) {
    if (!file) return null;
    const result = path.relative(root, file);
    if (result === '..' || result.startsWith(`..${path.sep}`) || path.isAbsolute(result)) return null;
    return result.split(path.sep).join('/') || '.';
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const direct = context.parentURL === testUrl && specifier === shape.binding.module;
      try {
        const result = nextResolve(specifier, context);
        if (direct && result.url.startsWith('file:')) state.entryUrl = result.url;
        return result;
      } catch (error) {
        if (direct && error.code === (shape.binding.commonjs ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND') &&
            /^\.\.?\//.test(specifier)) {
          const requestPath = path.resolve(path.dirname(testFile), specifier);
          const rel = relative(requestPath);
          const importerMatches = shape.binding.commonjs
            ? error.requireStack?.[0] === testFile
            : error.url === pathToFileURL(requestPath).href;
          if (rel && rel !== '.' && importerMatches) state.missingModule = rel;
        }
        throw error;
      }
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url.startsWith('file:')) {
        const rel = relative(fileURLToPath(url));
        if (rel) {
          copyFiles.add(rel);
          try {
            const destination = relative(realpath(fileURLToPath(url)));
            if (destination) copyFiles.add(destination);
          } catch {
            state.problems.push('loaded module realpath unavailable');
          }
        }
        if (url === state.entryUrl && rel) {
          try {
            state.modulePath = relative(realpath(fileURLToPath(url)));
          } catch {
            state.problems.push('public module realpath unavailable');
          }
        }
      }
      return result;
    },
  });

  // The nearest attributable caller decides: module loading inside Node is not a copy reference,
  // while copy code (including module top-level code that Node's loader runs) is.
  function fromCopy() {
    const stack = new Error().stack;
    if (typeof stack !== 'string') return false;
    for (const line of stack.split('\n').slice(2)) {
      if (line.includes('node:internal/modules/')) return false;
      if (line.includes(`${root}/`) || line.includes(pathToFileURL(root).href + '/')) return true;
    }
    return false;
  }

  // A string argument is only a reference when it names a valid, existing repository path in the copy.
  function inputPath(value) {
    if (value.includes('\\') || value.includes('\0')) return null;
    const file = path.resolve(value);
    const rel = relative(file);
    if (!rel || rel.split('/').some((part) => ['.', '..', '.git'].includes(part))) return null;
    try {
      return lstat(file, { throwIfNoEntry: false }) ? file : null;
    } catch {
      return null;
    }
  }

  function recordPath(value, attributes = {}) {
    const file = resolvedPath(value);
    const rel = relative(file);
    if (rel === null || rel === relative(testFile)) return;
    const { metadataOnly, ...reference } = attributes;
    if (metadataOnly && copyFiles.has(rel)) reference.metadataOnly = true;
    state.references.push({ path: rel, ...reference });
  }

  const bothPaths = new Set(['rename', 'link', 'copyFile', 'cp']);
  const listDirectory = new Set(['readdir', 'opendir', 'rmdir', 'rm', 'rename', 'cp']);
  const metadata = new Set(['stat', 'lstat', 'statfs', 'exists', 'realpath', 'readlink', 'access']);
  const operations = new Set([...bothPaths, ...listDirectory, ...metadata,
    'open', 'readFile', 'unlink', 'mkdir', 'mkdtemp', 'symlink',
    'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes', 'truncate', 'writeFile',
    'appendFile', 'createReadStream', 'createWriteStream', 'watch', 'watchFile', 'unwatchFile',
  ]);

  function wrapPathOperation(operation, original) {
    return function (...args) {
      if (fromCopy()) {
        const attributes = {};
        if (listDirectory.has(operation)) attributes.entries = true;
        if (operation === 'access') attributes.access = typeof args[1] === 'number' ? args[1] : 0;
        if (metadata.has(operation)) attributes.metadataOnly = true;
        recordPath(args[operation === 'symlink' ? 1 : 0], attributes);
        if (bothPaths.has(operation)) recordPath(args[1], attributes);
      }
      return Reflect.apply(original, this, args);
    };
  }

  for (const api of [fs, fsPromises]) {
    for (const name of Object.keys(api)) {
      const operation = name.replace(/Sync$/, '');
      const original = api[name];
      if (typeof original !== 'function') continue;
      if (operation === 'glob' || operation === 'mkdtempDisposable') {
        api[name] = function (...args) {
          if (fromCopy()) state.problems.push(`unresolved fs.${name} path set`);
          return Reflect.apply(original, this, args);
        };
      }
      if (!operations.has(operation)) continue;
      const wrapper = wrapPathOperation(operation, original);
      if (typeof original.native === 'function') wrapper.native = wrapPathOperation(operation, original.native);
      api[name] = wrapper;
    }
  }

  const chdir = process.chdir;
  process.chdir = function (...args) {
    if (fromCopy()) recordPath(args[0]);
    return Reflect.apply(chdir, this, args);
  };

  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork',
    '_forkChild', 'ChildProcess']) {
    if (typeof childProcess[name] !== 'function' || name === 'ChildProcess') continue;
    const original = childProcess[name];
    childProcess[name] = function (...args) {
      if (fromCopy()) state.childStarted = true;
      return Reflect.apply(original, this, args);
    };
  }
  const realSpawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function (...args) {
    if (fromCopy()) state.childStarted = true;
    return Reflect.apply(realSpawn, this, args);
  };
  syncBuiltinESMExports();

  const then = Promise.prototype.then;
  const { method } = shape;
  function wrap(context) {
    const assertions = context.assert;
    const delegate = assertions[method];
    const descriptor = Object.getOwnPropertyDescriptor(assertions, method);
    if (!descriptor || !descriptor.writable || typeof delegate !== 'function') {
      throw new Error('Node test context assertion cannot be measured');
    }
    Object.defineProperty(assertions, method, { ...descriptor, value: function (...args) {
      const observation = { invoked: true };
      state.assertions.push(observation);
      let thrown;
      const observe = (error) => {
        thrown = error;
        throw error;
      };
      if (method === 'throws') {
        const callback = args[0];
        args[0] = () => {
          try { return callback(); } catch (error) { return observe(error); }
        };
      } else if (method === 'rejects') {
        args[0] = Reflect.apply(then, args[0], [undefined, observe]);
      }
      const completed = (status, error) => {
        observation.status = status;
        observation.exceptionFromEntry = seenExceptions.has(thrown);
        observation.assertionFailure = error?.code === 'ERR_ASSERTION';
      };
      try {
        const result = Reflect.apply(delegate, this, args);
        if (method === 'rejects') return Reflect.apply(then, result, [
          (value) => { completed('pass'); return value; },
          (error) => { completed('fail', error); throw error; },
        ]);
        completed('pass');
        return result;
      } catch (error) {
        completed('fail', error);
        throw error;
      }
    } });
  }

  Object.defineProperty(globalThis, stateKey, { value: Object.freeze({
    wrap,
    recordInput(args) {
      try {
        const input = serializeInput(args);
        state.inputs.push(input);
        const collect = ({ type, value }) => {
          if (type === 'str' && value) {
            const file = inputPath(value);
            if (file) recordPath(file);
          }
          if (type === 'array') value.forEach(collect);
          if (type === 'object') value.forEach(([, item]) => collect(item));
        };
        input.args.forEach(collect);
      } catch (error) {
        state.problems.push(error.message);
      }
    },
    recordException(error) {
      if (seenExceptions.has(error)) return;
      seenExceptions.add(error);
      state.exceptions.push({ name: error.name, message: error.message });
    },
    set absent(value) { state.missingSymbol = value; },
  }) });

  process.on('uncaughtExceptionMonitor', (error) => {
    if (error?.name === 'SyntaxError' && typeof error.message === 'string' &&
        String(error.stack).startsWith(testUrl + ':')) {
      state.linkError = error.message;
    }
  });
  process.on('exit', () => writeFile(output, JSON.stringify({
    ...state, loadedFiles: [...copyFiles].filter((file) => file !== relative(testFile)),
  }), { mode: 0o600 }));

  const worker = new Worker(new URL('./node-inspector.mjs', import.meta.url), {
    execArgv: [], workerData: { testUrl, shape, stateKey },
  });
  await new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.ready) resolve();
      if (message.error) {
        state.problems.push(message.error);
        if (message.initializing) reject(new Error(message.error));
      }
    });
    worker.on('error', (error) => { state.problems.push(error.message); reject(error); });
    worker.on('exit', (code) => { if (code) state.problems.push('inspector worker stopped'); });
  });
  worker.unref();
}
