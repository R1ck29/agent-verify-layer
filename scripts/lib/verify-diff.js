'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { requestId, requestPath, requestTransaction, writePrivateJson } = require('./ledger');
const { capture, materialize, persistSnapshot, readSnapshot, repoPath, hash, within } = require('./snapshot');
const { checkProtection, collectDefinitions, samePublicInput } = require('./ast-guard');
const { canonical, sameValue, validateCase, additionAllowed, promptHasInput } = require('./case-policy');
const { V2_CONFIG_FILE, V2_TIMEOUT_MS } = require('./config');

const runnerNames = new Set(['node', 'pytest', 'unittest']);
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const documentPath = (file) => /\.(?:md|mdx|rst|adoc)$/i.test(file) ||
  /(?:^|\/)(?:README|CHANGELOG|LICENSE|CONTRIBUTING)$/i.test(file) ||
  /^(?:docs?|documentation)\/.*\.txt$/i.test(file);
const dataPath = /\.(?:[cm]?js[x]?|[cm]?ts[x]?|py[iwc]?|sh|bash|zsh|ps1|bat|cmd|rb|pl|php|so|node|wasm)$/i;

function transaction(repo, session, callback) {
  const result = requestTransaction(repo, session.agent, session.session, callback);
  if (!result.locked) throw new Error('Request ledger is busy');
  return result.value;
}

function budget(config) {
  const deadline = performance.now() + (config.timeoutMs ?? V2_TIMEOUT_MS);
  return () => {
    const ms = Math.floor(deadline - performance.now());
    if (ms < 1) throw new Error('Verification time budget exhausted');
    return ms;
  };
}

function withSnapshot(repo, id, snapshot, options, callback) {
  const { root, cleanup } = materialize(repo, id, snapshot, options);
  try {
    return callback(root);
  } finally {
    cleanup();
  }
}

function begin(repo, session, config, prompt, options = {}) {
  return transaction(repo, session, (previous, save) => {
    if (previous) writePrivateJson(requestPath(repo, previous.id + '.state.json'), previous);
    const id = requestId();
    const nodeDependencies = config.runner !== 'unsupported';
    const state = {
      id, prompt: typeof prompt === 'string' ? prompt : '', config,
      nodeDependencies, cases: {}, attempts: [], interventions: 0,
    };
    save(state);
    const before = capture(repo, { includePaths: config.includePaths, nodeDependencies });
    const remaining = budget(config);
    const withCopy = (callback, copyOptions = {}) => withSnapshot(repo, id, before, copyOptions, callback);
    let detection;
    try {
      const detect = options.detectRunner ?? require('./runner-detection').detectRunner;
      detection = config.runner === 'unsupported' ? { config, files: [], tests: [] }
        : detect(before, { config, remaining, withCopy });
    } catch (error) {
      detection = { config: { ...config, runner: 'unsupported' }, files: [], tests: [], reason: error.message };
    }
    persistSnapshot(repo, id, before);
    Object.assign(state, {
      beforeId: before.id, config: detection.config, tests: detection.tests,
      files: detection.files, runnerReason: detection.reason,
    });
    save(state);
    return state;
  });
}

function current(repo, state) {
  return capture(repo, { includePaths: state.config.includePaths, nodeDependencies: state.nodeDependencies });
}

function requireRequest(state) {
  if (!state?.beforeId) throw new Error('No complete request start recorded for this host and session');
  return state;
}

function hasCodeChanges(before, after) {
  if (before.dependencyId !== after.dependencyId) return true;
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].some((file) => {
    if (documentPath(file)) return false;
    const old = before.files[file];
    const next = after.files[file];
    return !sameValue(old && [old.kind, old.mode, old.hash ?? old.target],
      next && [next.kind, next.mode, next.hash ?? next.target]);
  });
}

function caseOverlay(before, after, data, protection) {
  if (own(before.files, data.testFile) || own(before.directories, data.testFile)) {
    throw new Error('The case test path already existed at request start');
  }
  const paths = [data.testFile, ...data.inputFiles];
  return Object.fromEntries(paths.map((file) => {
    const entry = own(after.files, file);
    if (entry?.kind !== 'file') throw new Error('Case file must be a regular snapshot file: ' + file);
    if (file !== data.testFile && (protection.protectedFiles.includes(file) || dataPath.test(file) ||
        path.posix.basename(file) === V2_CONFIG_FILE || file.split('/').includes('node_modules') ||
        own(before.directories, file) || own(before.files, file)?.kind === 'symlink')) {
      throw new Error('inputFiles cannot contain code, settings or protected paths: ' + file);
    }
    return [file, entry];
  }));
}

function caseFingerprint(data, overlay) {
  const { input, inputFiles, expected, entry, testFile, testId, assertion } = data;
  return hash(canonical({ input, inputFiles, expected, entry, testFile, testId, assertion,
    files: Object.entries(overlay).map(([file, item]) => [file, item.hash, item.mode]) }));
}

function referenceState(root, reference) {
  const name = reference.path === '.' ? '.' : repoPath(reference.path);
  const target = path.join(root, name);
  // realpath can fail for absent leaves, so validate existing parents as well.
  for (let location = target; location !== root; location = path.dirname(location)) {
    let real;
    try {
      real = fs.realpathSync(location);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    if (!within(root, real)) throw new Error('Reference resolves outside the isolated copy');
    break;
  }
  function statInfo(file, follow) {
    let stat;
    try {
      stat = (follow ? fs.statSync : fs.lstatSync)(file);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { kind: 'absent' };
      throw error;
    }
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) return { kind: 'symlink', mode, target: fs.readlinkSync(file), resolved: statInfo(file, true) };
    if (stat.isFile()) return reference.metadataOnly ? { kind: 'file', mode } :
      { kind: 'file', mode, hash: hash(fs.readFileSync(file)) };
    if (stat.isDirectory()) return reference.entries ?
      { kind: 'directory', mode, entries: fs.readdirSync(file).filter((entry) => entry !== '__pycache__').sort() } :
      { kind: 'directory', mode };
    throw new Error('Unsupported initial state for ' + name);
  }
  const result = statInfo(target, false);
  if (reference.access !== undefined) {
    if (!Number.isInteger(reference.access) || reference.access < 0 || reference.access > 7) {
      throw new Error('Unrecognized requested path permissions');
    }
    const modes = [4, 2, 1].filter((mode) => (mode & reference.access) !== 0);
    result.access = (modes.length ? modes : [0]).map((mode) => {
      try {
        fs.accessSync(target, mode);
        return true;
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return false;
        throw error;
      }
    });
  }
  return result;
}

function captureReferences(beforeCopy, afterCopy, observations, fixed) {
  const refs = new Map();
  for (const reference of [...observations, ...fixed.map(({ reference }) => reference)]) {
    if (!reference || typeof reference.path !== 'string') throw new Error('Invalid path observation');
    refs.set(canonical(reference), reference);
  }
  const captured = [];
  for (const [key, reference] of [...refs].sort(([a], [b]) => a.localeCompare(b))) {
    const before = beforeCopy((root) => referenceState(root, reference));
    const after = afterCopy((root) => referenceState(root, reference));
    if (!sameValue(before, after)) throw new Error('Initial path state differs: ' + reference.path);
    const prior = fixed.find((item) => canonical(item.reference) === key);
    if (prior && !sameValue(prior.initial, after)) throw new Error('Fixed path state changed: ' + reference.path);
    captured.push({ reference, initial: after });
  }
  return captured;
}

function measured(run, data, snapshot) {
  return ['pass', 'mismatch'].includes(run.status) && run.loaded === true && run.called === true &&
    run.assertions === 1 && sameValue(run.input, data.input) && typeof run.modulePath === 'string' &&
    own(snapshot.files, run.modulePath)?.kind === 'file' &&
    (run.status !== 'pass' || data.expected.kind !== 'exception' || run.exceptionFromEntry === true);
}

function compareSuites(beforeCopy, afterCopy, runner, state, remaining) {
  const run = (copy) => copy((root) => runner.runSuite({
    root, config: state.config, tests: state.tests, timeoutMs: remaining(),
  }));
  const read = (report) => {
    if (!report.ok || !Array.isArray(report.tests)) throw new Error(report.reason ?? 'Public suite did not finish');
    const expected = state.tests.map(({id}) => id);
    const ids = report.tests.map(({id}) => id);
    if (new Set(ids).size !== ids.length || !sameValue(ids, expected) ||
        report.tests.some(({status}) => !['pass', 'fail', 'skip'].includes(status))) {
      throw new Error('Public suite test IDs, order or results could not be matched');
    }
    return report.tests;
  };
  const before = read(run(beforeCopy));
  const after = read(run(afterCopy));
  const lost = before.flatMap(({status}, i) => status === 'pass' && after[i].status !== 'pass' ? [i] : []);
  const retry = lost.length ? read(run(afterCopy)) : null;
  const regressions = lost.filter((i) => retry[i].status !== 'pass').map((i) => before[i].id);
  const unstable = lost.filter((i) => retry[i].status === 'pass').map((i) => before[i].id);
  return { before, after, retry, regressions, unstable };
}

function pendingCases(state, snapshotId) {
  return Object.entries(state.cases).filter(([, row]) => row.fixed && !row.withdrawal &&
    !(row.snapshotId === snapshotId && row.result?.status === 'pass')).map(([id]) => id);
}

function verifyCase(repo, session, data, options = {}) {
  return transaction(repo, session, (state, save) => {
    requireRequest(state);
    const { config, id } = state;
    if (session.request && session.request !== id) throw new Error('Request ID is no longer active');
    if (!runnerNames.has(config.runner)) throw new Error(state.runnerReason ?? 'Unsupported runner');
    validateCase(data, id, config.runner);
    const key = data.caseId;
    const previous = own(state.cases, key);
    if (!previous && Object.keys(state.cases).length >= 3) throw new Error('At most 3 case IDs per request');
    if (previous?.withdrawal) throw new Error('This case was withdrawn');
    const remaining = budget(config);
    const before = readSnapshot(repo, id);
    const after = current(repo, state);
    const protection = checkProtection(before, after, { ...config, existingTestFiles: state.files });
    if (!sameValue(own(before.files, V2_CONFIG_FILE)?.hash, own(after.files, V2_CONFIG_FILE)?.hash)) {
      protection.ok = false;
      protection.violations.push('Verify v0.2 repository settings changed during the request');
    }
    let result;
    let fixed = previous?.fixed;
    if (!protection.ok) {
      result = { status: 'error', reason: 'Protected paths changed', violations: protection.violations };
    } else {
      let overlay;
      try {
        overlay = caseOverlay(before, after, data, protection);
      } catch (error) {
        if (!fixed) throw error;
      }
      const fingerprint = overlay && caseFingerprint(data, overlay);
      if (fixed && fixed.fingerprint !== fingerprint) {
        throw new Error('Fixed content changed. Use a new caseId (' + (3 - Object.keys(state.cases).length) +
          ' remaining). The original case stays open.');
      }
      const runner = options.runner ?? require('./runners/' + config.runner);
      const copy = (snapshot, callback, extra = {}) => withSnapshot(repo, id, snapshot, {
        nodeDependencies: config.runner === 'node', ...extra,
      }, callback);
      const beforeCase = (callback) => copy(before, callback, { overlay });
      const afterCase = (callback) => copy(after, callback, { overlay });
      const run = (withCopy) => withCopy((root) => runner.runCase({
        root, caseData: data, config, timeoutMs: remaining(),
      }));
      try {
        const earlier = run(beforeCase);
        const later = run(afterCase);
        const loadedFiles = new Set([...earlier.loadedFiles ?? [], ...later.loadedFiles ?? []]);
        if (data.inputFiles.some((file) => loadedFiles.has(file))) {
          throw new Error('An inputFiles path was loaded as code');
        }
        const references = beforeCase((beforeRoot) => afterCase((afterRoot) => captureReferences(
          (fn) => fn(beforeRoot), (fn) => fn(afterRoot),
          [...earlier.references ?? [], ...later.references ?? []], fixed?.references ?? [],
        )));
        let beforeStatus = 'error';
        if (measured(earlier, data, before)) beforeStatus = earlier.status;
        if (earlier.status === 'absent' && !earlier.called &&
            (earlier.absence === 'module' && !earlier.loaded ||
             earlier.absence === 'symbol' && earlier.loaded && own(before.files, earlier.modulePath)?.kind === 'file')) {
          beforeStatus = 'absent';
        }
        result = { status: 'error', before: beforeStatus, earlier, later };
        if (!measured(later, data, after)) {
          result.reason = later.reason ?? 'The requested entry, input or assertion was not measured';
        } else if (later.status === 'mismatch') {
          fixed ??= { fingerprint, references };
          result.status = 'mismatch';
          result.reason = 'The requested assertion failed after the change';
        } else {
          const nonBoundary = data.nonBoundary === true || promptHasInput(state.prompt, later.input, config.runner) ||
            samePublicInput(before, state.files, data.entry, later.input);
          const addition = beforeStatus === 'absent' && additionAllowed({
            prompt: state.prompt, caseData: data, evidence: earlier, modulePath: later.modulePath,
            beforeFiles: Object.keys(before.files), afterFiles: Object.keys(after.files),
            definitions: collectDefinitions(before), publicTestFiles: state.files,
          });
          if (beforeStatus === 'error') {
            result.reason = earlier.reason ?? 'The before run could not be classified as evidence';
          } else {
            const suites = compareSuites(
              (callback) => copy(before, callback),
              (callback) => copy(after, callback, { omit: Object.keys(after.files).filter((file) =>
                !own(before.files, file) && (file === data.testFile || /\.vl_req_[a-z0-9_]+\.test\.m?js$/.test(file) ||
                  /^test_vl_req_/.test(path.posix.basename(file)))) }),
              runner, state, remaining,
            );
            const boundary = !nonBoundary && (beforeStatus === 'mismatch' || addition);
            result = { ...result, status: 'pass', nonBoundary, boundary, addition, suites,
              reason: suites.regressions.length ? 'Existing public tests regressed' :
                boundary ? undefined : 'The run did not establish boundary evidence' };
          }
        }
      } catch (error) {
        result = { ...result, status: 'error', reason: error.message };
      }
    }
    state.cases = { ...state.cases, [key]: { data, fixed, snapshotId: after.id, result } };
    (state.attempts ??= []).push({ caseId: key, snapshotId: after.id, status: result.status, before: result.before,
      boundary: result.boundary, reason: result.reason });
    const openFailures = pendingCases(state, after.id);
    save(state);
    return { ...result, requestId: id, caseId: key, snapshotId: after.id, openFailures };
  });
}

function withdrawCase(repo, session, key, reason) {
  return transaction(repo, session, (state, save) => {
    requireRequest(state);
    if (session.request && session.request !== state.id) throw new Error('Request ID is no longer active');
    const row = own(state.cases, key);
    if (!row?.fixed || row.withdrawal || row.result?.status === 'pass' && row.snapshotId === current(repo, state).id) {
      throw new Error('Only open failures can be withdrawn');
    }
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('A withdrawal reason is required');
    row.withdrawal = reason.trim();
    save(state);
    return { status: 'withdrawn', caseId: key, reason: row.withdrawal };
  });
}

function assess(repo, state) {
  const before = readSnapshot(repo, state.id);
  const after = current(repo, state);
  if (!hasCodeChanges(before, after)) return { status: 'unchanged', snapshotId: after.id };
  if (state.config.runner === 'unsupported') {
    return { status: 'unsupported', reason: state.runnerReason, snapshotId: after.id };
  }
  const rows = Object.values(state.cases);
  const withdrawals = rows.filter((row) => row.withdrawal).map((row) => ({
    caseId: row.data.caseId, reason: row.withdrawal,
  }));
  if (withdrawals.length) return { status: 'withdrawn', withdrawals, snapshotId: after.id };
  const openFailures = pendingCases(state, after.id);
  const currentRows = rows.filter((row) => row.snapshotId === after.id);
  const regressions = [...new Set(currentRows.flatMap((row) => row.result?.suites?.regressions ?? []))];
  if (state.intentional?.snapshotId === after.id && regressions.includes(state.intentional.testId)) {
    return { status: 'intentional', ...state.intentional, regressions, openFailures };
  }
  if (!openFailures.length && !regressions.length && currentRows.some(({result}) =>
    result?.status === 'pass' && result.boundary)) return { status: 'verified', snapshotId: after.id };
  const stale = rows.some(({result, snapshotId}) => result?.boundary && snapshotId !== after.id);
  const reason = currentRows.at(-1)?.result?.reason;
  return { status: stale ? 'stale' : 'unverified', snapshotId: after.id, openFailures, regressions, reason };
}

function finalStatus(repo, session, afterAssess = (result) => result) {
  return transaction(repo, session, (state, save) => {
    requireRequest(state);
    if (session.request && session.request !== state.id) throw new Error('Request ID is no longer active');
    return afterAssess(assess(repo, state), state, save);
  });
}

function recordIntentional(repo, session, testId, requestQuote, reason) {
  return finalStatus(repo, session, (assessment, state, save) => {
    if (!assessment.regressions?.includes(testId) || !requestQuote?.trim() ||
        !state.prompt.includes(requestQuote.trim()) || !reason?.trim()) {
      throw new Error('Provide a reproduced public regression, a request quote, and the conflicting expectation');
    }
    state.intentional = { snapshotId: assessment.snapshotId, testId, requestQuote: requestQuote.trim(), reason: reason.trim() };
    save(state);
    return { status: 'intentional', ...state.intentional };
  });
}

function generateConfig(repo) {
  const config = { mode: 'observe', runner: 'auto', timeoutMs: V2_TIMEOUT_MS, protectedPaths: [] };
  const remaining = budget(config);
  const snapshot = capture(repo, { nodeDependencies: true });
  const id = requestId();
  const withCopy = (callback, options) => withSnapshot(repo, id, snapshot, options, callback);
  const result = require('./runner-detection').detectRunner(snapshot, { config, remaining, withCopy });
  const { runner, protectedPaths, unittestStartDir, unittestTopLevelDir, unittestPattern } = result.config;
  return { verifyV2: { mode: 'observe', runner, protectedPaths, unittestStartDir, unittestTopLevelDir, unittestPattern },
    reason: result.reason, missing: result.missing };
}

module.exports = { begin, verifyCase, withdrawCase, finalStatus, recordIntentional, generateConfig };
