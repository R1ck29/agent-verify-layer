'use strict';
// Helpers shared by `vl.js doctor` and `scripts/install.js` for reading Claude Code settings
// files and recognising this tool's own hook handlers.
const fs = require('node:fs');
const path = require('node:path');

// Our hooks are recognised by an exec-form arg whose basename is vl.js followed by "hook".
// Timeouts and other fields are deliberately not compared (matching on them once caused double
// registration elsewhere). Shell-form commands are never treated as ours: the installer only
// writes exec form, and a foreign command that merely mentions vl.js must not be touched.
function isOwnHandler(h) {
  if (!h || typeof h !== 'object' || h.type !== 'command' || !Array.isArray(h.args)) return false;
  const i = h.args.findIndex((a) => typeof a === 'string' && path.basename(a.replace(/\\/g, '/')) === 'vl.js');
  return i >= 0 && h.args[i + 1] === 'hook';
}

// Reads a JSON settings file. { exists:false } when absent; { error } when unreadable or not JSON.
function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? { exists: false } : { exists: true, error: e.message };
  }
  try {
    const data = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { exists: true, error: 'top level is not an object' };
    return { exists: true, data, text };
  } catch (e) {
    return { exists: true, error: `not valid JSON (${e.message})` };
  }
}

// Every hook handler in a settings object: [{ event, group, handler }].
function allHandlers(settings) {
  const out = [];
  const hooks = settings && settings.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) out.push({ event, group, handler });
    }
  }
  return out;
}

function managedSettingsPath() {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

module.exports = { isOwnHandler, readJsonFile, allHandlers, managedSettingsPath };
