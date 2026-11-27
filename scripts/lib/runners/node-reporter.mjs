import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function testPath(file) {
  return file?.startsWith('file:') ? fileURLToPath(file) : file;
}

function errorEvidence(error) {
  if (!error) return null;
  const cause = error.cause ?? error;
  return {
    failure: error.failureType,
    signal: error.signal,
    code: cause.code,
    message: typeof cause === 'string' ? cause : cause.message,
    stack: typeof cause.stack === 'string' ? cause.stack.split('\n').slice(0, 20) : [],
  };
}

export default async function* reporter(events) {
  const output = process.env.VL_NODE_REPORT;
  if (!output) throw new Error('missing Node runner report path');
  let hasSummary = false;
  let success = true;
  for await (const { type, data } of events) {
    let event;
    if (type === 'test:pass' || type === 'test:fail') {
      event = {
        type, file: testPath(data.entryFile ?? data.file), source: testPath(data.file), name: data.name, className: data.classname,
        line: data.line, column: data.column, nesting: data.nesting, testNumber: data.testNumber,
        kind: data.details?.type, status: data.skip || data.todo ? 'skip' : type === 'test:pass' ? 'pass' : 'fail',
        error: errorEvidence(data.details?.error),
      };
      if (event.status === 'fail') success = false;
    }
    if (type === 'test:summary') {
      event = { type, file: data.file, success: data.success, counts: data.counts };
      if (!data.file) hasSummary = true;
    }
    if (event) appendFileSync(output, JSON.stringify(event) + '\n');
  }
  // Node 18 has no summary event. Only mark the report complete after the stream ends.
  if (!hasSummary) appendFileSync(output, JSON.stringify({ type: 'test:summary', success }) + '\n');
}
