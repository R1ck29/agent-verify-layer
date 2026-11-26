'use strict';

const path = require('node:path').posix;
const { inspectNodeScripts, inspectPython } = require('./ast-guard');
const node = require('./runners/node');
const pytest = require('./runners/pytest');
const unittest = require('./runners/unittest');

const sorted = (values) => [...new Set(values)].sort();
const filesOf = (tests) => sorted(tests.map(({ file }) => file).filter(Boolean));
const testKey = ({ id, file, className, name }) => file
  ? [file, className, name?.replace(/\[.*\]$/, '')].filter(Boolean).join('::')
  : id;

function discoveryConfig(snapshot, inventory) {
  const files = sorted([...inventory.testcaseFiles, ...inventory.loadTests]);
  const regularFiles = files.filter((file) => path.basename(file) !== '__init__.py');
  const patterns = ['test*.py', '*_test.py'];
  const names = regularFiles.map((file) => path.basename(file));
  let matching = patterns;
  if (names.every((name) => /^test.*\.py$/.test(name))) matching = [patterns[0]];
  else if (names.every((name) => /_test\.py$/.test(name))) matching = [patterns[1]];
  const units = files.map((file) => {
    const dir = path.dirname(file);
    const start = path.basename(file) === '__init__.py' ? path.dirname(dir) : dir;
    return start === '.' ? [] : start.split('/');
  });
  const common = [];
  for (const part of units[0] ?? []) {
    if (!units.every((unit) => unit[common.length] === part)) break;
    common.push(part);
  }
  const start = common.join('/') || '.';
  const allPackages = common.every((_, i) =>
    snapshot.files[common.slice(0, i + 1).join('/') + '/__init__.py']?.kind === 'file');
  return {
    unittestStartDir: start,
    unittestTopLevelDir: allPackages ? '.' : start,
    unittestPattern: matching,
    loadTests: inventory.loadTests,
  };
}

function detectRunner(snapshot, { withCopy, remaining = () => 30000, config = {} }) {
  let protectedPaths = config.protectedPaths ?? [];
  const unsupported = (reason, missing = []) => ({
    config: { ...config, runner: 'unsupported', protectedPaths }, tests: [], files: [], reason, missing,
  });
  const timeout = () => {
    const time = Math.floor(remaining());
    if (!(time > 0)) throw new Error('Runner detection budget exhausted');
    return time;
  };
  const collect = (runner, options, nodeDependencies = false) => {
    const result = withCopy((root) => runner({ root, config: options, timeoutMs: timeout() }), { nodeDependencies });
    timeout();
    return result;
  };
  if (config.runner === 'unsupported') return unsupported('Repository declares an unsupported runner');

  try {
    const python = inspectPython(snapshot, timeout());
    const js = inspectNodeScripts(snapshot);
    const isPytest = python.tests.some(({ kind }) => kind === 'pytest');
    const publicPytest = python.hasPytestConfig || python.hasPytestDependency;
    const pythonConfig = { ...config, pytestConfig: python.pytestConfig };
    const unitConfig = { ...pythonConfig, ...discoveryConfig(snapshot, python) };
    const parseErrors = Object.keys(python.parseErrors);
    let pythonError = parseErrors.length ? 'Python source or configuration could not be inspected: ' + parseErrors.join(', ') : null;
    if (Object.entries(snapshot.files).some(([file, entry]) => entry.kind === 'symlink' &&
        /(?:\.py$|(?:^|\/)(?:\.?pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini)$)/.test(file))) {
      pythonError = 'Python source or configuration uses a symlink';
    }

    const hasPytest = !pythonError && (publicPytest || isPytest) && pytest.available(timeout());
    let publicTests = [];
    if (publicPytest && !pythonError) {
      if (!hasPytest) pythonError = 'Public pytest setup requires pytest';
      else {
        const result = collect(pytest.collectSuite, pythonConfig);
        if (!result.ok) pythonError = result.reason;
        else publicTests = result.tests;
      }
    }

    let discovered = [];
    if (!pythonError && python.loadTests.length) {
      const result = collect(unittest.collectSuite, unitConfig);
      if (!result.ok) pythonError = result.reason;
      else discovered = result.tests;
    }
    const pythonTests = [...python.tests, ...publicTests, ...discovered];
    let nodeError = js.violations.join('\n') || null;
    const nodeConfig = { ...config, nodeCommand: js.nodeCommand };
    let nodeTests = [];
    if (js.nodeCommand) {
      const result = collect(node.runSuite, nodeConfig, true);
      if (!result.ok) nodeError = result.reason;
      else if (result.tests.some(({ file }) => snapshot.files[file]?.kind !== 'file')) {
        nodeError = 'Node reported a test outside the regular snapshot files';
      } else nodeTests = result.tests;
    }
    const nodeFiles = sorted([...js.testFiles, ...filesOf(nodeTests)]);
    protectedPaths = sorted([...protectedPaths, ...nodeFiles,
      ...python.testFiles, ...python.loadTests, ...filesOf(pythonTests)]);
    const hasPython = pythonError || pythonTests.length > 0 || python.testcaseFiles.length > 0;
    const hasNode = nodeError || nodeFiles.length > 0;
    if (hasPython && hasNode) {
      const details = [pythonError, nodeError].filter(Boolean);
      return unsupported(['Python and Node public tests or collection errors coexist', ...details].join('\n'));
    }
    if (pythonError || nodeError) return unsupported(pythonError || nodeError);

    let runner;
    let options;
    let tests;
    let missing;
    if (hasPytest && pythonTests.length && (publicPytest || isPytest)) {
      runner = 'pytest';
      options = { ...pythonConfig, existingTestFiles: sorted([...filesOf(pythonTests), ...python.testcaseFiles]) };
      const result = collect(pytest.collectSuite, options);
      if (!result.ok) return unsupported(result.reason);
      tests = result.tests;
    } else if (!isPytest && (python.testcaseFiles.length || discovered.length)) {
      runner = 'unittest';
      options = unitConfig;
      if (!python.loadTests.length) {
        const result = collect(unittest.collectSuite, options);
        if (!result.ok) return unsupported(result.reason);
        discovered = result.tests;
      }
      tests = discovered;
    } else if (!hasPython && js.nodeCommand && nodeFiles.length) {
      runner = 'node';
      options = nodeConfig;
      tests = nodeTests;
      const actual = new Set(filesOf(nodeTests));
      missing = nodeFiles.filter((file) => !actual.has(file));
    } else return unsupported('No supported runner covers the public tests');

    if (!missing) {
      const actual = new Set(tests.map(testKey));
      missing = sorted(pythonTests.map(testKey)).filter((id) => !actual.has(id));
    }
    if (missing.length) return unsupported('Runner collection missed public tests', missing);
    if (!tests.length) return unsupported('Runner collected no public tests');
    if (config.runner && config.runner !== 'auto' && config.runner !== runner) {
      return unsupported('Configured runner does not cover the public tests');
    }
    return { config: { ...options, runner, protectedPaths }, tests, files: filesOf(tests) };
  } catch (error) {
    return unsupported(error.message);
  }
}

module.exports = { detectRunner };
