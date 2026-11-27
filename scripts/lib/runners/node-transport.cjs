'use strict';

// A child test process serializes its test events into stdout. Emit those
// binary frames synchronously so a pipe reporting unsupported async writes
// cannot silently turn a file with missing results into an apparent pass.
if (process.env.NODE_TEST_CONTEXT === 'child-v8') {
  const { writeSync } = require('node:fs');
  const stdout = process.stdout;
  const originalWrite = stdout.write;
  stdout.write = function writeFrame(chunk, encoding, callback) {
    if (!Buffer.isBuffer(chunk) || chunk[0] !== 0xff) {
      return originalWrite.call(this, chunk, encoding, callback);
    }
    let offset = 0;
    while (offset < chunk.length) {
      try {
        offset += writeSync(1, chunk, offset, chunk.length - offset);
      } catch (error) {
        if (error.code !== 'EINTR') throw error;
      }
    }
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') process.nextTick(done);
    return true;
  };
}
