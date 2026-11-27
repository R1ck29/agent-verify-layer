'use strict';

// Reads all of stdin as text. Never rejects: a TTY, a closed pipe or a hang
// (no EOF within timeoutMs) all resolve with whatever was received.
function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.destroy(); // a pipe that never closes must not keep the process alive
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c) => chunks.push(Buffer.from(c)));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    process.stdin.on('close', finish);
  });
}

// Broken, empty or non-object JSON yields {} so hooks degrade to "do nothing".
function parseJsonObject(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function shortError(e) {
  const msg = e && e.message ? e.message : String(e);
  return msg.split('\n')[0].slice(0, 200);
}

module.exports = { readStdin, parseJsonObject, shortError };
