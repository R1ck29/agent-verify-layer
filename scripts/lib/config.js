'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { readJsonFile } = require('./settings');

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
  // The same reader as the installer (BOM-tolerant): the hook, mark and `install --check` must
  // agree on what config.json says (XREVIEW #11).
  const raw = readJsonFile(configPath()).data;
  if (!raw) return cfg;
  if (['off', 'observe'].includes(raw.mode)) cfg.mode = raw.mode;
  // "enforce" does not exist in v0.1: anything else behaves as observe.
  if (Array.isArray(raw.skipGlobs) && raw.skipGlobs.every((g) => typeof g === 'string')) {
    cfg.skipGlobs = raw.skipGlobs;
  }
  if (Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) cfg.timeoutMs = raw.timeoutMs;
  if (typeof raw.markHint === 'boolean') cfg.markHint = raw.markHint;
  return cfg;
}

const V2_CONFIG_FILE = '.verify-layer.json';
const V2_TIMEOUT_MS = 30000;
const v2Off = Object.freeze({ mode: 'off', runner: 'unsupported', adversarial: false });

function loadV2Config(root) {
  try {
    const file = path.join(root, V2_CONFIG_FILE);
    if (!fs.lstatSync(file).isFile()) return v2Off;
    const flag = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    const raw = JSON.parse(fs.readFileSync(file, { flag, encoding: 'utf8' }).replace(/^\uFEFF/, '')).verifyV2;
    if (!raw || !['observe', 'enforce'].includes(raw.mode) ||
        (raw.adversarial !== undefined && raw.adversarial !== false)) return v2Off;
    if (raw.runner !== undefined && !['pytest', 'unittest', 'node', 'unsupported'].includes(raw.runner)) return v2Off;
    const { repoPath } = require('./snapshot');
    const cfg = {
      mode: raw.mode,
      runner: raw.runner ?? 'auto',
      adversarial: false,
      timeoutMs: raw.timeoutMs ?? V2_TIMEOUT_MS,
      includePaths: raw.includePaths ?? [],
      protectedPaths: raw.protectedPaths ?? [],
    };
    if (raw.timeoutMs === null || !Number.isSafeInteger(cfg.timeoutMs) || cfg.timeoutMs < 1 || cfg.timeoutMs > V2_TIMEOUT_MS) return v2Off;
    for (const field of ['includePaths', 'protectedPaths']) {
      if (!Array.isArray(cfg[field])) return v2Off;
      cfg[field] = [...new Set(cfg[field].map(repoPath))].sort();
    }
    for (const field of ['unittestStartDir', 'unittestTopLevelDir']) {
      if (raw[field] !== undefined) cfg[field] = raw[field] === '.' ? '.' : repoPath(raw[field]);
    }
    if (raw.unittestPattern !== undefined) {
      const patterns = raw.unittestPattern;
      if (!Array.isArray(patterns) || !patterns.length || patterns.some((p) => !['test*.py', '*_test.py'].includes(p))) return v2Off;
      cfg.unittestPattern = [...new Set(patterns)];
    }
    return cfg;
  } catch {
    return v2Off;
  }
}

module.exports = {
  DEFAULTS, DEFAULT_SKIP_GLOBS, claudeDir, configDir, configPath, loadConfig,
  V2_CONFIG_FILE, V2_TIMEOUT_MS, loadV2Config,
};
