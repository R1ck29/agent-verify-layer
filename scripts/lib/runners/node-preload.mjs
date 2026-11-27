import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { MessageChannel, Worker, isMainThread, receiveMessageOnPort } from 'node:worker_threads';
import Module, { syncBuiltinESMExports } from 'node:module';
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

  const { commonjs, module: entry } = shape.binding;
  const requestPath = /^\.\.?\//.test(entry) ? path.resolve(path.dirname(testFile), entry) : null;
  const requestUrl = requestPath && pathToFileURL(requestPath).href;
  function recordMissingModule() {
    const rel = relative(requestPath);
    if (rel && rel !== '.') state.missingModule = rel;
  }

  function recordLoad(url, realFile) {
    if (!url.startsWith('file:')) return;
    const file = fileURLToPath(url);
    const rel = relative(file);
    if (!rel) return;
    copyFiles.add(rel);
    try {
      const actual = realFile === undefined ? realpath(file) : realFile;
      if (!actual) throw new Error('loaded module realpath unavailable');
      const destination = relative(actual);
      if (destination) copyFiles.add(destination);
      if (url === state.entryUrl) state.modulePath = destination;
    } catch {
      state.problems.push('loaded module realpath unavailable');
    }
  }

  if (commonjs) {
    // Node 22 can resolve a require before the synchronous hooks see its original specifier.
    const resolveFilename = Module._resolveFilename;
    Module._resolveFilename = function (specifier, parent, ...args) {
      const direct = parent?.filename === testFile && specifier === entry;
      try {
        const file = Reflect.apply(resolveFilename, this, [specifier, parent, ...args]);
        if (direct && path.isAbsolute(file)) state.entryUrl = pathToFileURL(file).href;
        return file;
      } catch (error) {
        if (direct && error.code === 'MODULE_NOT_FOUND' && error.requireStack?.[0] === testFile) recordMissingModule();
        throw error;
      }
    };
  }

  const legacyLoader = typeof Module.registerHooks !== 'function';
  let loaderPort;
  function collectLoads() {
    if (!loaderPort) return;
    let received;
    while ((received = receiveMessageOnPort(loaderPort))) {
      const { entryUrl, missingUrl, loadedUrl, realFile } = received.message;
      if (entryUrl) state.entryUrl = entryUrl;
      if (requestUrl && missingUrl === requestUrl) recordMissingModule();
      if (loadedUrl) recordLoad(loadedUrl, realFile);
    }
  }

  if (legacyLoader) {
    const { port1, port2 } = new MessageChannel();
    loaderPort = port1;
    Module.register(new URL('./node-loader.mjs', import.meta.url), {
      data: { port: port2, testUrl, entry: commonjs ? undefined : entry },
      transferList: [port2],
    });
    const load = Module.prototype.load;
    Module.prototype.load = function (filename) {
      recordLoad(pathToFileURL(filename).href);
      return Reflect.apply(load, this, [filename]);
    };
  } else {
    Module.registerHooks({
      resolve(specifier, context, nextResolve) {
        const direct = context.parentURL === testUrl && specifier === entry;
        try {
          const result = nextResolve(specifier, context);
          if (direct && result.url.startsWith('file:')) state.entryUrl = result.url;
          return result;
        } catch (error) {
          if (direct && (commonjs
            ? error.code === 'MODULE_NOT_FOUND' && error.requireStack?.[0] === testFile
            : error.code === 'ERR_MODULE_NOT_FOUND' && error.url === requestUrl)) recordMissingModule();
          throw error;
        }
      },
      load(url, context, nextLoad) {
        const result = nextLoad(url, context);
        recordLoad(url);
        return result;
      },
    });
  }

  // The nearest attributable caller decides: module loading inside Node is not a copy reference,
  // while copy code (including module top-level code that Node's loader runs) is.
  function fromCopy() {
    const stack = new Error().stack;
    if (typeof stack !== 'string') return false;
    for (const line of stack.split('\n').slice(2)) {
      if (line.includes('node:internal/modules/')) return false;
      if (line.includes(`${root}${path.sep}`) || line.includes(pathToFileURL(root).href + '/')) return true;
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
    if (metadataOnly) {
      collectLoads();
      if (copyFiles.has(rel)) reference.metadataOnly = true;
    }
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
    const delegate = assertions?.[method];
    const descriptor = assertions && Object.getOwnPropertyDescriptor(assertions, method);
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
  process.on('exit', () => {
    collectLoads();
    writeFile(output, JSON.stringify({
      ...state, loadedFiles: [...copyFiles].filter((file) => file !== relative(testFile)),
    }), { mode: 0o600 });
  });

  const worker = new Worker(new URL('./node-inspector.mjs', import.meta.url), {
    execArgv: [], workerData: { testUrl, shape, stateKey, legacyLoader },
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
