'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { checkNodeCase } = require('./node-ast-check');
const { sameValue } = require('../case-policy');

const reporter = path.join(__dirname, 'node-reporter.mjs');
const transport = path.join(__dirname, 'node-transport.cjs');
const preload = pathToFileURL(path.join(__dirname, 'node-preload.mjs')).href;

function within(root, file) {
  if (!file || typeof file !== 'string') return null;
  const rel = path.relative(root, path.resolve(root, file));
  return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
    ? rel.split(path.sep).join('/') : null;
}

function copyPath(root, file) {
  const rel = within(root, file);
  if (!rel) throw new Error('test path outside the isolated copy');
  const actual = fs.realpathSync(path.join(root, rel));
  if (!within(root, actual)) throw new Error('test path resolves outside the isolated copy');
  return actual;
}

function safeCwd(root, rel) {
  return !rel || rel === '.' ? root : copyPath(root, rel);
}

function tempRun(root, body) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-node-run-')));
  try {
    if (within(root, temp)) throw new Error('Node evidence path is inside the isolated copy');
    return body(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function run(root, cwd, nodeArgs, timeoutMs, temp, capture) {
  const report = path.join(temp, 'report.jsonl');
  const env = {
    PATH: process.env.PATH, LANG: process.env.LANG, TZ: process.env.TZ,
    HOME: temp, XDG_CONFIG_HOME: temp, TMPDIR: temp,
    VL_NODE_REPORT: report,
  };
  if (capture) env.VL_NODE_CAPTURE = capture;
  const child = spawnSync(process.execPath, [
    '--require', transport, ...(capture ? ['--import', preload] : []), '--test',
    '--test-concurrency=1', '--test-reporter=' + reporter, ...nodeArgs,
  ], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'],
    timeout: timeoutMs ?? 15_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
  });
  if (child.error || child.signal || ![0, 1].includes(child.status)) {
    throw new Error(child.error?.code === 'ETIMEDOUT' ? 'Node runner timed out' : 'Node runner failed to start or exited abnormally');
  }
  let events;
  try {
    events = fs.readFileSync(report, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    throw new Error('Node runner did not produce a readable report');
  }
  const summaries = events.filter((event) => event.type === 'test:summary' && !event.file);
  if (summaries.length !== 1 || Boolean(summaries[0].success) !== (child.status === 0)) {
    throw new Error('Node runner did not complete its report');
  }
  const outcomes = events.filter(({ type }) => ['test:pass', 'test:fail'].includes(type)).map((event) => ({
    ...event, file: within(root, event.file), source: within(root, event.source),
    envelope: event.name === event.file || !event.file,
  }));
  return { outcomes, success: summaries[0].success };
}

function supportedNodeArgs(args, flagsOnly = false) {
  if (!Array.isArray(args)) throw new Error('invalid node test command');
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string' || !arg) throw new Error('invalid node test argument');
    if (!arg.startsWith('-')) continue;
    if (/^--test-(?:name|skip)-pattern=.+$/.test(arg)) {
      flags.push(arg);
      continue;
    }
    if (/^--test-(?:name|skip)-pattern$/.test(arg) && typeof args[++i] === 'string') {
      flags.push(arg, args[i]);
      continue;
    }
    throw new Error('unsupported option in node test command');
  }
  return flagsOnly ? flags : args;
}

function runSuite({ root, config = {}, timeoutMs, tests }) {
  try {
    root = fs.realpathSync(root);
    if (tests?.length === 0) return { ok: true, tests: [], files: [] };
    const explicitFiles = tests ? [...new Set(tests.map((test) => typeof test === 'string' ? test : test.file))]
      : config.nodeFiles;
    const cwd = safeCwd(root, config.nodeCwd ?? config.nodeCommand?.cwd);
    const configuredArgs = config.nodeArgs ?? config.nodeCommand?.args ?? [];
    const args = explicitFiles ? [
      ...supportedNodeArgs(configuredArgs, true), ...explicitFiles.map((file) => copyPath(root, file)),
    ] : supportedNodeArgs(configuredArgs);
    return tempRun(root, (temp) => {
      const { outcomes } = run(root, cwd, args, timeoutMs, temp);
      if (outcomes.some(({ envelope, file, error, status }) => !file || envelope ||
          error?.signal || error?.failure && !['testCodeFailure', 'subtestsFailed', 'hookFailed'].includes(error.failure) && status !== 'skip')) {
        return { ok: false, tests: [], files: [], reason: 'Node suite could not report individual test results' };
      }
      const result = [];
      const counters = new Map();
      for (const row of outcomes) {
        const name = [row.className, row.name].filter(Boolean).join(' > ');
        const prefix = row.file + '::' + name;
        const count = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, count);
        result.push({ id: count === 1 ? prefix : prefix + '#' + count, file: row.file, status: row.status });
      }
      const files = [...new Set(result.map(({ file }) => file))].sort();
      return { ok: true, tests: result, files };
    });
  } catch (error) {
    return { ok: false, tests: [], files: [], reason: error.message };
  }
}

function runCase({ root, caseData, timeoutMs }) {
  const errorResult = (reason, evidence = {}) => ({ status: 'error', loaded: false, called: false, assertions: 0,
    references: [], ...evidence, reason });
  try {
    root = fs.realpathSync(root);
    const testFile = copyPath(root, caseData.testFile);
    const shape = checkNodeCase(fs.readFileSync(testFile, 'utf8'), caseData);
    if (!shape.ok) return errorResult(shape.reason);
    return tempRun(root, (temp) => {
      const capture = path.join(temp, 'input.json');
      const output = path.join(temp, 'evidence.json');
      fs.writeFileSync(capture, JSON.stringify({ root, testFile, output, shape }), { mode: 0o600 });
      const { outcomes } = run(root, root, [testFile], timeoutMs, temp, capture);
      if (!fs.existsSync(output)) return errorResult('Node preload produced no entry evidence');
      const state = JSON.parse(fs.readFileSync(output, 'utf8'));
      const matches = outcomes.filter(({ file, name, nesting, envelope }) =>
        !envelope && file === caseData.testFile && name === caseData.testId && nesting === 0);
      const [row] = matches;
      const evidence = {
        loaded: Boolean(state.modulePath),
        called: state.inputs.length === 1,
        input: state.inputs[0],
        modulePath: state.modulePath,
        assertions: state.assertions.length,
        references: state.references,
        loadedFiles: state.loadedFiles,
      };
      if (state.childStarted) return errorResult('Node child process references could not be measured', evidence);
      if (state.problems.length) return errorResult(state.problems.join('; '), evidence);
      if (state.missingModule && !evidence.loaded && !evidence.called && !row) {
        return { ...evidence, status: 'absent', absence: 'module', modulePath: state.missingModule };
      }
      const missingExport = `The requested module '${shape.binding.module}' does not provide an export named '${shape.binding.symbol}'`;
      if (evidence.loaded && !evidence.called &&
          (state.missingSymbol || (!row && state.linkError === missingExport))) {
        return { ...evidence, status: 'absent', absence: 'symbol' };
      }
      if (matches.length !== 1 || outcomes.length !== 1 || row.status === 'skip') {
        return errorResult('requested Node test did not complete exactly once', evidence);
      }
      if (!evidence.loaded || !evidence.called) return errorResult('public entry load or assertion call not measured', evidence);
      if (!sameValue(evidence.input, caseData.input)) return errorResult('actual arguments do not match the case input', evidence);

      const [comparison] = state.assertions;
      const exceptionExpectation = caseData.expected.kind === 'exception';
      const fromEntry = comparison?.exceptionFromEntry ?? false;
      if (evidence.assertions === 1 && row.status === 'pass' && comparison.status === 'pass' &&
          (!exceptionExpectation || fromEntry)) return { ...evidence, status: 'pass', exceptionFromEntry: fromEntry };
      if (evidence.assertions === 1 && row.status === 'fail' && comparison.status === 'fail' &&
          (comparison.assertionFailure || fromEntry)) {
        return { ...evidence, status: 'mismatch', exceptionFromEntry: fromEntry };
      }
      if (evidence.assertions === 0 && row.status === 'fail' && state.exceptions.length === 1 &&
          state.exceptions[0].message === row.error?.message) {
        return { ...evidence, status: 'mismatch', assertions: 1, exceptionFromEntry: true };
      }
      return errorResult('requested Node comparison result was not established', evidence);
    });
  } catch (error) {
    return errorResult(error.message);
  }
}

module.exports = { runCase, runSuite };
