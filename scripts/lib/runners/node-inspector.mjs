import { Session } from 'node:inspector';
import { parentPort, workerData } from 'node:worker_threads';

const { testUrl, shape, stateKey } = workerData;
const session = new Session();
session.connectToMainThread();
const scripts = new Map();
const entryFrames = new Set();
let assertionBreakpoint;
let entryBreakpoint;
let initializing = true;
let closed = false;

function command(method, params = {}) {
  return new Promise((resolve, reject) => session.post(method, params,
    (error, result) => error ? reject(error) : resolve(result)));
}

function testFrame(frames) {
  return frames.find(({ location }) => scripts.get(location.scriptId) === testUrl);
}

function sameAssertion(frame) {
  if (!frame) return false;
  const { lineNumber, columnNumber } = frame.location;
  const { start, end } = shape.range;
  const line = lineNumber + 1;
  if (line < start.line || line > end.line) return false;
  return (line !== start.line || columnNumber >= start.column) &&
    (line !== end.line || columnNumber <= end.column);
}

function frameKey(frame) {
  const { scriptId, lineNumber, columnNumber } = frame.functionLocation ?? frame.location;
  return JSON.stringify([scriptId, lineNumber, columnNumber]);
}

async function evaluate(frame, expression, returnByValue = false) {
  const result = await command('Debugger.evaluateOnCallFrame', {
    callFrameId: frame.callFrameId, expression, returnByValue, silent: true,
  });
  if (result.exceptionDetails) throw new Error('could not evaluate debugger evidence');
  return result.result;
}

const stateExpression = `globalThis[${JSON.stringify(stateKey)}]`;

async function onAssertion(frames) {
  const frame = testFrame(frames);
  if (!sameAssertion(frame)) throw new Error('assertion breakpoint resolved outside the requested range');
  await command('Debugger.removeBreakpoint', { breakpointId: assertionBreakpoint });
  const binding = await evaluate(frame, shape.binding.name);
  if (binding.type === 'undefined' && shape.binding.commonjs) {
    await evaluate(frame, `${stateExpression}.absent = true`);
    return;
  }
  if (binding.type !== 'function' || !binding.objectId) throw new Error('public entry is not a function');

  await evaluate(frame, `${stateExpression}.wrap(${shape.context})`);
  const breakpoint = await command('Debugger.setBreakpointOnFunctionCall', { objectId: binding.objectId });
  entryBreakpoint = breakpoint.breakpointId;
  await command('Debugger.setPauseOnExceptions', { state: 'all' });
}

async function onEntry(frames) {
  const frame = testFrame(frames);
  if (!sameAssertion(frame)) return;
  entryFrames.add(frameKey(frames[0]));
  await evaluate(frame, `${stateExpression}.recordInput([${shape.args.join(',')}])`);
}

async function onException(params) {
  const origin = params.callFrames.some((frame) => entryFrames.has(frameKey(frame)));
  if (!origin || !params.data?.objectId) return;
  const { result, exceptionDetails } = await command('Runtime.callFunctionOn', {
    objectId: params.data.objectId,
    functionDeclaration: 'function (key) { globalThis[key].recordException(this); }',
    arguments: [{ value: stateKey }], returnByValue: true, silent: true,
  });
  if (exceptionDetails || result.type !== 'undefined') throw new Error('could not record entry exception');
}

session.on('Debugger.scriptParsed', ({ params }) => scripts.set(params.scriptId, params.url));
session.on('Debugger.paused', ({ params }) => {
  void (async () => {
    try {
      if (params.hitBreakpoints?.includes(assertionBreakpoint)) await onAssertion(params.callFrames);
      else if (entryBreakpoint && params.hitBreakpoints?.includes(entryBreakpoint)) await onEntry(params.callFrames);
      else if (params.reason === 'exception' || params.reason === 'promiseRejection') await onException(params);
    } catch (error) {
      parentPort.postMessage({ error: error.message });
    } finally {
      if (!closed) await command('Debugger.resume').catch(() => {});
    }
  })();
});

parentPort.on('message', (message) => {
  if (message !== 'close') return;
  closed = true;
  session.disconnect();
  parentPort.close();
});

try {
  await command('Debugger.enable');
  assertionBreakpoint = (await command('Debugger.setBreakpointByUrl', {
    url: testUrl,
    lineNumber: shape.range.start.line - 1,
    columnNumber: shape.range.start.column,
  })).breakpointId;
  initializing = false;
  parentPort.postMessage({ ready: true });
} catch (error) {
  parentPort.postMessage({ error: error.message, initializing });
  session.disconnect();
  parentPort.close();
}
