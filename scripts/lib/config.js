'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_SKIP_GLOBS = [
  '*.md',
  '*.mdx',
  'docs/**',
  'doc/**',
  '**/tests/**',
  '**/test/**',
  '**/__tests__/**',
  '*.test.*',
  '*.spec.*',
  '*_test.*',
  'test_*.*',
];

const DEFAULTS = Object.freeze({
  mode: 'observe',
  skipGlobs: DEFAULT_SKIP_GLOBS,
  timeoutMs: 8000,
  // Add one line to the verify context telling the agent to run `vl.js mark verify` once the
  // checks pass (records the tree at check time; see lib/mark.js). false turns the line off.
  markHint: true,
});

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// VL_CONFIG_DIR overrides the location (used by tests and by the installer).
function configDir() {
  return process.env.VL_CONFIG_DIR || path.join(claudeDir(), 'verify-layer');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function loadConfig() {
  const cfg = { ...DEFAULTS, skipGlobs: [...DEFAULT_SKIP_GLOBS] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return cfg;
  }
  if (!raw || typeof raw !== 'object') return cfg;
  if (['off', 'observe'].includes(raw.mode)) cfg.mode = raw.mode;
  // "enforce" does not exist in v0.1: anything else behaves as observe.
  if (Array.isArray(raw.skipGlobs) && raw.skipGlobs.every((g) => typeof g === 'string')) {
    cfg.skipGlobs = raw.skipGlobs;
  }
  if (Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) cfg.timeoutMs = raw.timeoutMs;
  if (typeof raw.markHint === 'boolean') cfg.markHint = raw.markHint;
  return cfg;
}

module.exports = { DEFAULTS, DEFAULT_SKIP_GLOBS, claudeDir, configDir, configPath, loadConfig };
