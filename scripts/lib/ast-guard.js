'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { matchGlob } = require('./glob');
const { splitCommand } = require('./shellquote');

const PYTHON_GUARD = path.join(__dirname, 'py', 'ast_guard.py');
const PYTHON_SETTINGS = new Set(['pytest.ini', '.pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini']);
const NODE_SOURCE = /\.(?:js|mjs|cjs)$/;

function python(request) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-ast-'));
  try {
    const filename = path.join(scratch, 'input.json');
    fs.writeFileSync(filename, JSON.stringify(request), { mode: 0o600 });
    const input = fs.openSync(filename, 'r');
    try {
      const result = spawnSync('python3', ['-I', '-B', PYTHON_GUARD], {
        cwd: scratch,
        stdio: [input, 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (result.status !== 0 || result.error) {
        throw new Error('isolated Python AST inspection failed', { cause: result.error });
      }
      return JSON.parse(result.stdout);
    } finally {
      fs.closeSync(input);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function plainText(entry) {
  if (entry?.kind !== 'file') throw new Error('protected path is not a regular file');
  return new TextDecoder('utf-8', { fatal: true }).decode(entry.data);
}

function pythonSources(snapshot) {
  return Object.fromEntries(Object.entries(snapshot.files)
    .filter(([file, entry]) => entry.kind === 'file' && (
      file.endsWith('.py') || PYTHON_SETTINGS.has(path.posix.basename(file))
      || /(?:^|\/)requirements[^/]*(?:\/|$)/.test(file)
    ))
    .map(([file, entry]) => [file, plainText(entry)]));
}

function inspectPython(snapshot) {
  return python({ action: 'inspect', sources: pythonSources(snapshot) });
}

function sameEntry(left, right) {
  if (!left || !right || left.kind !== right.kind || left.mode !== right.mode) return left === right;
  if (left.kind === 'file') return left.hash === right.hash;
  return left.target === right.target;
}

function inProtectedPath(file, protectedPaths) {
  return protectedPaths.some((raw) => {
    const prefix = raw.replace(/^\.\//, '').replace(/\/$/, '');
    return prefix === '.' || prefix === file || file.startsWith(prefix + '/')
      || (/[?*{]/.test(prefix) && matchGlob(prefix, file));
  });
}

function defaultNodeTest(file) {
  if (!NODE_SOURCE.test(file) || file.split('/').includes('node_modules')) return false;
  return file.split('/').slice(0, -1).includes('test')
    || /(?:^test(?:[.-])|[._-]test\.)/.test(path.posix.basename(file));
}

function defaultPythonTest(file) {
  return /^test.*\.py$|_test\.py$/.test(path.posix.basename(file));
}

// Npm scripts are inspected as literals and never handed to a shell.
function scriptCommands(source) {
  if (typeof source !== 'string' || /[$`\\\r\n<>|&!]/.test(source.replaceAll('&&', ''))) {
    throw new Error('dynamic npm command');
  }
  const commands = [];
  let start = 0;
  let quote = '';
  for (let offset = 0; offset < source.length; offset++) {
    const char = source[offset];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ';' || source.startsWith('&&', offset)) {
      const words = splitCommand(source.slice(start, offset));
      if (!words?.length) throw new Error('empty npm command');
      commands.push(words);
      if (char === '&') offset++;
      start = offset + 1;
    }
  }
  const words = splitCommand(source.slice(start));
  if (!words?.length) throw new Error('empty or unbalanced npm command');
  commands.push(words);
  return commands;
}

function relativePath(dir, specifier) {
  if (!specifier || path.posix.isAbsolute(specifier) || specifier.includes('\\')) {
    throw new Error('npm script path is outside the snapshot');
  }
  const file = path.posix.join(dir, specifier);
  if (file === '..' || file.startsWith('../')) throw new Error('npm script path escapes the snapshot');
  return file;
}

function resolveLocal(files, dir, specifier) {
  const candidate = relativePath(dir, specifier);
  const matches = [
    candidate,
    ...['.js', '.cjs', '.mjs', '.json'].map((suffix) => candidate + suffix),
    ...['index.js', 'index.cjs', 'index.mjs'].map((basename) => path.posix.join(candidate, basename)),
  ];
  for (const file of matches) if (files[file]?.kind === 'file') return file;
  throw new Error('local npm helper is missing: ' + candidate);
}

function localImports(source, file) {
  // The same vendored parser used for Node proof and protection also covers
  // dependencies of project-owned npm scripts and preload files.
  const { parseSource } = require('./runners/node-ast-check');
  const tree = parseSource(source, file);
  const specifiers = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    let specifier;
    if (/^(?:ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration)$/.test(node.type)) {
      specifier = node.source;
    } else if (node.type === 'ImportExpression') {
      specifier = node.source;
    } else if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
      if (node.arguments.length !== 1) throw new Error('dynamic npm helper import');
      specifier = node.arguments[0];
    }
    if (specifier) {
      if (specifier.type !== 'Literal' || typeof specifier.value !== 'string') {
        throw new Error('dynamic npm helper import');
      }
      if (specifier.value.startsWith('.')) specifiers.push(specifier.value);
      else if (path.posix.isAbsolute(specifier.value)) throw new Error('npm helper import escapes snapshot');
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(tree);
  return specifiers;
}

function inspectNodeScripts(snapshot) {
  const { files } = snapshot;
  const protectedFiles = new Set();
  const packages = new Map();
  const nodeCommands = [];
  const violations = [];
  const testFiles = new Set(Object.keys(files).filter(defaultNodeTest));

  for (const file of Object.keys(files).sort()) {
    if (path.posix.basename(file) !== 'package.json' || file.split('/').includes('node_modules')) continue;
    const cwd = path.posix.dirname(file);
    const scriptNames = new Set();
    const active = new Set();
    const packageCommands = [];
    try {
      const manifest = JSON.parse(plainText(files[file]));
      const scripts = manifest.scripts ?? {};
      if (typeof scripts !== 'object' || Array.isArray(scripts)) throw new Error('invalid scripts object');
      packages.set(file, { scripts, scriptNames });

      function protectLocal(dir, specifier) {
        const helper = resolveLocal(files, dir, specifier);
        if (protectedFiles.has(helper)) return;
        protectedFiles.add(helper);
        if (NODE_SOURCE.test(helper)) {
          for (const dependency of localImports(plainText(files[helper]), helper)) {
            protectLocal(path.posix.dirname(helper), dependency);
          }
        }
      }

      function visitScript(name, forwarded = [], primary = false) {
        if (active.has(name)) throw new Error('cyclic npm script reference');
        active.add(name);
        for (const step of ['pre' + name, name, 'post' + name]) {
          scriptNames.add(step);
          if (!Object.hasOwn(scripts, step)) {
            if (name === step && name !== 'test') throw new Error('referenced npm script is missing: ' + name);
            continue;
          }
          const commands = scriptCommands(scripts[step]);
          if (step === name) commands.at(-1).push(...forwarded);
          for (const words of commands) visitCommand(words, primary && step === name);
        }
        active.delete(name);
      }

      function visitCommand(words, primary) {
        const [program, ...args] = words;
        if (program === 'npm') {
          while (args[0] === '--silent' || args[0] === '-s') args.shift();
          const operation = args.shift();
          if (operation !== 'run' && operation !== 'run-script' && operation !== 'test') {
            throw new Error('npm script dispatch could not be resolved');
          }
          const name = operation === 'test' ? 'test' : args.shift();
          if (!name || !/^[a-zA-Z0-9_:.\-]+$/.test(name) || (args.length && args.shift() !== '--')) {
            throw new Error('npm script reference is dynamic');
          }
          visitScript(name, args, primary);
          return;
        }
        if (['echo', 'printf', 'true', 'false', 'pytest'].includes(program)) return;
        if (program === 'python3' || program === 'python') {
          while (args[0] === '-I' || args[0] === '-B') args.shift();
          if (args[0] === '-m' && ['pytest', 'unittest'].includes(args[1])) return;
          if (args[0]?.endsWith('.py')) {
            protectLocal(cwd, args[0]);
            return;
          }
          throw new Error('Python npm script could not be resolved');
        }
        if (program !== 'node' && program !== 'nodejs') throw new Error('unsupported npm shell command: ' + program);

        const testMode = args.includes('--test');
        let positionals = false;
        for (let index = 0; index < args.length; index++) {
          const arg = args[index];
          const [flag, inline] = arg.split(/=(.*)/s, 2);
          if (!positionals && ['-r', '--require', '--import'].includes(flag)) {
            const module = inline ?? args[++index];
            if (!module?.startsWith('.')) throw new Error('npm preload must be a local file');
            protectLocal(cwd, module);
          } else if (!positionals && flag === '--') {
            positionals = true;
          } else if (!positionals && flag.startsWith('-')) {
            if (!/^--(?:test|test-[a-z-]+|experimental-test-coverage|enable-source-maps|no-warnings|disable-warning)$/.test(flag)) {
              throw new Error('unsupported npm Node option: ' + flag);
            }
            if (flag !== '--test' && inline === undefined && [
              '--test-concurrency', '--test-name-pattern', '--test-skip-pattern',
              '--test-shard', '--test-timeout', '--test-isolation',
            ].includes(flag)) index++;
          } else {
            if (!testMode) {
              protectLocal(cwd, arg);
              return;
            }
            positionals = true;
            const spec = relativePath(cwd, arg);
            for (const candidate of Object.keys(files)) {
              if (NODE_SOURCE.test(candidate) && (
                candidate === spec || candidate.startsWith(spec + '/') || matchGlob(spec, candidate)
              )) testFiles.add(candidate);
            }
          }
        }
        if (testMode && primary) packageCommands.push({ file, cwd, args: args.filter((arg) => arg !== '--test') });
        else if (!testMode) throw new Error('npm Node command has no script');
      }

      visitScript('test', [], true);
      if (packageCommands.length > 1) throw new Error('multiple Node test invocations in npm script');
      nodeCommands.push(...packageCommands);
    } catch (error) {
      violations.push(file + ': ' + error.message);
    }
  }
  if (nodeCommands.length > 1) violations.push('multiple package.json Node test invocations');
  return {
    nodeCommand: violations.length || nodeCommands.length !== 1 ? null : nodeCommands[0],
    protectedFiles: [...protectedFiles].sort(),
    testFiles: [...testFiles].sort(),
    packages,
    violations,
  };
}

function compareNodeSettings(before, after, node) {
  const violations = [];
  const manifests = new Set([
    ...node.packages.keys(),
    ...Object.keys(after.files).filter((file) => path.posix.basename(file) === 'package.json'
      && !file.split('/').includes('node_modules')),
  ]);
  for (const file of manifests) {
    if (sameEntry(before.files[file], after.files[file])) continue;
    try {
      const metadata = after.files[file] ? JSON.parse(plainText(after.files[file])) : {};
      const { scripts, scriptNames } = node.packages.get(file) ?? { scripts: {}, scriptNames: [] };
      const names = new Set(['test', 'pretest', 'posttest', ...scriptNames]);
      for (const name of names) {
        if ((Object.hasOwn(scripts, name) ? scripts[name] : undefined) !== (
          metadata.scripts && Object.hasOwn(metadata.scripts, name) ? metadata.scripts[name] : undefined
        )) {
          violations.push(file + ': protected npm script changed: ' + name);
        }
      }
    } catch (error) {
      violations.push(file + ': could not compare npm settings: ' + error.message);
    }
  }
  return violations;
}

function checkProtection(before, after, config = {}) {
  const oldFiles = before.files;
  const newFiles = after.files;
  const node = inspectNodeScripts(before);
  const violations = [...node.violations, ...compareNodeSettings(before, after, node)];
  const protectedFiles = new Set(node.protectedFiles);
  const nodeTests = new Set(node.testFiles);
  const pythonFiles = new Set();
  const extraPaths = config.protectedPaths ?? [];
  const knownTests = new Set(config.existingTestFiles ?? []);
  for (const file of Object.keys(oldFiles)) {
    if (defaultPythonTest(file)) knownTests.add(file);
  }
  let beforePython;
  let afterPython;
  try {
    beforePython = pythonSources(before);
    afterPython = pythonSources(after);
    if (Object.keys(beforePython).length) {
      const inventory = python({ action: 'inspect', sources: beforePython });
      for (const file of [...inventory.testFiles, ...inventory.loadTests]) knownTests.add(file);
    }
  } catch (error) {
    violations.push(error.message);
  }
  for (const file of new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)])) {
    const name = path.posix.basename(file);
    const oldEntry = oldFiles[file];
    const newEntry = newFiles[file];
    const settings = PYTHON_SETTINGS.has(name) || name === 'package.json';
    const conftest = name === 'conftest.py';
    const inScope = knownTests.has(file) || nodeTests.has(file) || inProtectedPath(file, extraPaths);
    if (settings || conftest || inScope || protectedFiles.has(file)) protectedFiles.add(file);
    else continue;
    if ([oldEntry, newEntry].some((entry) => entry?.kind === 'symlink') && (
      settings || conftest || knownTests.has(file) || nodeTests.has(file)
    )) {
      violations.push(file + ': protected source or settings uses a symlink');
      continue;
    }
    if (sameEntry(oldEntry, newEntry)) continue;

    if (settings && [oldEntry, newEntry].some((entry) => entry && entry.kind !== 'file')) {
      violations.push(file + ': test settings could not be read as a regular file');
    } else if (node.protectedFiles.includes(file) || name === 'pytest.ini' || name === '.pytest.ini') {
      violations.push(file + ': immutable test configuration or preload changed');
    } else if (conftest || (oldEntry && inScope && !settings)) {
      if (!newEntry || newEntry.kind !== 'file' || (oldEntry && (
        oldEntry.kind !== 'file' || oldEntry.mode !== newEntry.mode
      ))) {
        violations.push(file + ': existing path or file mode changed');
      } else if (file.endsWith('.py')) {
        pythonFiles.add(file);
      } else if (NODE_SOURCE.test(file)) {
        try {
          const { checkNodeProtection } = require('./runners/node-guard');
          const issue = checkNodeProtection(plainText(oldEntry), plainText(newEntry), { file });
          if (issue) violations.push(file + ': ' + issue);
        } catch (error) {
          violations.push(file + ': could not compare Node AST: ' + error.message);
        }
      } else {
        violations.push(file + ': immutable test data changed');
      }
    }
  }
  if (beforePython && afterPython && (Object.keys(beforePython).length || Object.keys(afterPython).length)) {
    try {
      const files = new Set([...pythonFiles, ...[...protectedFiles].filter((file) => file.endsWith('.py') && oldFiles[file])]);
      violations.push(...python({
        action: 'compare', before: beforePython, after: afterPython, protected: [...files],
      }));
    } catch (error) {
      violations.push(error.message);
    }
  }
  return { ok: !violations.length, violations, protectedFiles: [...protectedFiles].sort(), nodeCommand: node.nodeCommand };
}

function collectDefinitions(snapshot) {
  const { definitions, parseErrors } = inspectPython(snapshot);
  if (Object.keys(parseErrors).some((file) => file.endsWith('.py'))) {
    throw new Error('Python definitions could not be inspected');
  }
  const result = new Set(definitions);
  for (const [file, entry] of Object.entries(snapshot.files)) {
    if (entry.kind === 'symlink' && (file.endsWith('.py') || NODE_SOURCE.test(file))) {
      throw new Error('source definitions behind a symlink could not be inspected');
    }
    if (entry.kind !== 'file' || !NODE_SOURCE.test(file)) continue;
    const { nodeDefinitions } = require('./runners/node-guard');
    for (const name of nodeDefinitions(plainText(entry), file)) result.add(name);
  }
  return [...result].sort();
}

module.exports = {
  checkProtection, collectDefinitions, defaultNodeTest, inspectNodeScripts, inspectPython,
};
