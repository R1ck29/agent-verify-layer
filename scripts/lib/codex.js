'use strict';
// Codex CLI wiring (sources/codex/hooks.md). Codex handlers have no `args` / `if` / `onFailure`:
// `command` is one string run through a shell, so the hook is built here with absolute paths
// instead of reusing the Claude plugin's hooks/hooks.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { quoteArg, splitCommand } = require('./shellquote');

const VL_PATH = path.resolve(__dirname, '..', 'vl.js');
const HOOK_TIMEOUT_S = 10; // Codex default is 600 s
const MATCHER = '^Bash$'; // shell commands and unified exec (exec_command) both match as Bash

function codexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

const STATUS_MESSAGE = 'verify-layer: recording commit';

// `node "<abs>/scripts/vl.js" hook commit --agent codex`, with every path quoted for the shell
// (single quotes when it holds $ or a backtick). Throws for a path no shell can carry literally.
function hookCommand(nodeCmd = 'node', vlPath = VL_PATH) {
  return `${quoteArg(nodeCmd)} ${quoteArg(vlPath, { always: true })} hook commit --agent codex`;
}

// The single matcher group this tool adds to Codex hooks.json (PostToolUse only: never gates).
function ownGroups(nodeCmd, vlPath) {
  return [
    {
      event: 'PostToolUse',
      group: {
        matcher: MATCHER,
        hooks: [{ type: 'command', command: hookCommand(nodeCmd, vlPath), timeout: HOOK_TIMEOUT_S, statusMessage: STATUS_MESSAGE }],
      },
    },
  ];
}

// Ours = exactly what ownGroups writes: PostToolUse, matcher ^Bash$, our statusMessage and a
// command of the form `<node> <path>/vl.js hook commit --agent codex`. A handler that only looks
// similar (another event, another sub-command, another matcher) belongs to somebody else and is
// never touched. The installer also supplies the exact registered paths; diagnostics can
// inspect the shape on its own.
function commandWords(h) {
  if (!h || typeof h !== 'object' || h.type !== 'command' || typeof h.command !== 'string') return null;
  const w = splitCommand(h.command);
  const ok = w && w.length === 6 && path.basename(w[1].replace(/\\/g, '/')) === 'vl.js' && w.slice(2).join(' ') === 'hook commit --agent codex';
  return ok ? w : null;
}

function isOwnCodexHandler(h, event, group, scriptPaths) {
  const script = ownScriptPath(h);
  if (!script || h.statusMessage !== STATUS_MESSAGE || (scriptPaths && !scriptPaths.has(script))) return false;
  if (event === undefined) return true;
  return event === 'PostToolUse' && !!group && group.matcher === MATCHER;
}

function ownScriptPath(h) {
  const w = commandWords(h);
  return w ? w[1] : null;
}

// AGENTS.md: two lines, appended (never overwriting). The second one carries this machine's path.
function agentsLines(nodeCmd = 'node', vlPath = VL_PATH) {
  if (/`/.test(vlPath) || /`/.test(nodeCmd)) throw new Error(`パスに使えない文字があります（AGENTS.md の行に書けません）: ${vlPath}`);
  const mark = `${quoteArg(nodeCmd)} ${quoteArg(vlPath, { always: true })} mark verify --agent codex`;
  return [
    '- コミットの前に、リポジトリに `verify` スキル（`.agents/skills/verify/`）があれば `$verify` を使う（ドキュメントとテストだけの変更は除く）。',
    `- verify の確認がすべて通ったら、コミットの前に \`${mark}\` を実行して確認した時点の状態を記録する（verify-layer。記録だけで作業は止めない）。`,
  ];
}

const AGENTS_LINE_RE = /verify-layer。記録だけで作業は止めない|リポジトリに `verify` スキル（`\.agents\/skills\/verify\/`）があれば/;

// The global instructions file Codex actually reads: a non-empty AGENTS.override.md wins.
function agentsFile(home) {
  const override = path.join(home, 'AGENTS.override.md');
  try {
    if (fs.statSync(override).size > 0) return override;
  } catch {
    /* no override */
  }
  return path.join(home, 'AGENTS.md');
}

// Minimal TOML lookup for the few keys we read (`[features] hooks`, `allow_managed_hooks_only`,
// `[projects."<path>"] trust_level`). Not a TOML parser: tables, dotted keys and `#` comments only.
// Returns the raw value text (e.g. 'false', '"trusted"') or undefined.
function tomlGet(text, dottedKey) {
  let table = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[[')) {
      table = null; // array of tables (e.g. [[hooks.PreToolUse]]): not looked up
      continue;
    }
    const h = /^\[(.+)\]\s*(#.*)?$/.exec(line);
    if (h) {
      table = h[1].trim().replace(/\s*\.\s*/g, '.');
      continue;
    }
    if (table === null) continue;
    const m = /^((?:"[^"]*"|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"[^"]*"|[A-Za-z0-9_-]+))*)\s*=\s*(.*?)\s*(#[^"']*)?$/.exec(line);
    if (!m) continue;
    const key = m[1].replace(/\s*\.\s*/g, '.');
    if ((table ? `${table}.${key}` : key) === dottedKey) return m[2];
  }
  return undefined;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Admin-enforced requirements. The doc copies do not give the location; these follow the system
// hooks.json locations (an assumption, reported as such by doctor).
function requirementsPaths(env = process.env) {
  if (env.VL_CODEX_REQUIREMENTS) return [path.resolve(env.VL_CODEX_REQUIREMENTS)]; // tests
  if (process.platform === 'win32') return [path.join(env.ProgramData || 'C:\\ProgramData', 'OpenAI', 'Codex', 'requirements.toml')];
  return ['/etc/codex/requirements.toml'];
}

const isFalse = (v) => v !== undefined && /^false$/i.test(String(v).trim());
const isTrue = (v) => v !== undefined && /^true$/i.test(String(v).trim());

// What blocks user hooks: { hooksOff: [where], managedOnly: [where] }.
function hookBlockers(home, env = process.env) {
  const out = { hooksOff: [], managedOnly: [] };
  const cfg = path.join(home, 'config.toml');
  const t = readText(cfg);
  if (t !== null && (isFalse(tomlGet(t, 'features.hooks')) || isFalse(tomlGet(t, 'features.codex_hooks')))) out.hooksOff.push(cfg);
  for (const req of requirementsPaths(env)) {
    const r = readText(req);
    if (r === null) continue;
    if (isFalse(tomlGet(r, 'features.hooks')) || isFalse(tomlGet(r, 'features.codex_hooks'))) out.hooksOff.push(req);
    if (isTrue(tomlGet(r, 'allow_managed_hooks_only'))) out.managedOnly.push(req);
  }
  return out;
}

// `codex --version` -> '0.170.0' (or the raw text), null when the command is missing or fails.
// VL_CODEX_BIN replaces the command (tests: a fake or a missing binary, never the real one).
function codexVersion(env = process.env) {
  const bin = env.VL_CODEX_BIN || 'codex';
  const win = process.platform === 'win32';
  const r = spawnSync(win && /\s/.test(bin) ? `"${bin}"` : bin, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true, shell: win, env });
  if (r.error || r.status !== 0) return null;
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout || '');
  return m ? m[1] : (r.stdout || '').trim() || 'unknown';
}

// `[projects."<path>"] trust_level` from config.toml for this repo: 'trusted' | 'untrusted' | null.
function projectTrust(configText, root) {
  // realpath: macOS /var -> /private/var, Windows 8.3 short names -> long names.
  const norm = (p) => {
    let r = path.resolve(p);
    try {
      r = fs.realpathSync.native(r);
    } catch {
      /* not on this machine: compare as written */
    }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const want = norm(root);
  let inTable = false;
  for (const raw of String(configText || '').split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]/.exec(line);
    if (h) {
      const p = h[1] !== undefined ? h[1].replace(/\\(.)/g, '$1') : h[2];
      inTable = norm(p) === want;
      continue;
    }
    if (line.startsWith('[')) {
      inTable = false;
      continue;
    }
    const m = inTable && /^trust_level\s*=\s*["']([^"']*)["']/.exec(line);
    if (m) return m[1];
  }
  return null;
}

module.exports = {
  codexVersion,
  projectTrust,
  tomlGet,
  readText,
  requirementsPaths,
  hookBlockers,
  VL_PATH,
  MATCHER,
  HOOK_TIMEOUT_S,
  codexHome,
  hookCommand,
  STATUS_MESSAGE,
  ownGroups,
  isOwnCodexHandler,
  ownScriptPath,
  agentsLines,
  AGENTS_LINE_RE,
  agentsFile,
};
