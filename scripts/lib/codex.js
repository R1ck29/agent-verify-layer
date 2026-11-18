'use strict';
// Codex CLI wiring (sources/codex/hooks.md). Codex handlers have no `args` / `if` / `onFailure`:
// `command` is one string run through a shell, so the hook is built here with absolute paths
// instead of reusing the Claude plugin's hooks/hooks.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VL_PATH = path.resolve(__dirname, '..', 'vl.js');
const HOOK_TIMEOUT_S = 10; // Codex default is 600 s
const MATCHER = '^Bash$'; // shell commands and unified exec (exec_command) both match as Bash

function codexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

function quote(p) {
  if (/["\r\n]/.test(p)) throw new Error(`パスに使えない文字があります: ${p}`);
  return /[\s&()^%!;$`'|<>]/.test(p) ? `"${p}"` : p;
}

// `node "<abs>/scripts/vl.js" hook commit --agent codex`. Always double-quoting the script path
// keeps it one argument in sh, cmd and PowerShell alike.
function hookCommand(nodeCmd = 'node', vlPath = VL_PATH) {
  if (/["\r\n]/.test(vlPath)) throw new Error(`パスに使えない文字があります: ${vlPath}`);
  return `${quote(nodeCmd)} "${vlPath}" hook commit --agent codex`;
}

// The single matcher group this tool adds to Codex hooks.json (PostToolUse only: never gates).
function ownGroups(nodeCmd, vlPath) {
  return [
    {
      event: 'PostToolUse',
      group: {
        matcher: MATCHER,
        hooks: [{ type: 'command', command: hookCommand(nodeCmd, vlPath), timeout: HOOK_TIMEOUT_S, statusMessage: 'verify-layer: recording commit' }],
      },
    },
  ];
}

// Ours = a command handler whose command runs a `vl.js` script with `hook ... --agent codex`.
// A foreign command that merely mentions vl.js (no `--agent codex` hook call) is never touched.
const OWN_RE = /^(?:"[^"]+"|\S+)\s+"([^"]*[\\/]vl\.js)"\s+hook\s+\S+(?:\s+\S+)*\s+--agent\s+codex\s*$/;

function isOwnCodexHandler(h) {
  return !!h && typeof h === 'object' && h.type === 'command' && typeof h.command === 'string' && OWN_RE.test(h.command);
}

function ownScriptPath(h) {
  const m = isOwnCodexHandler(h) ? OWN_RE.exec(h.command) : null;
  return m ? m[1] : null;
}

// AGENTS.md: two lines, appended (never overwriting). The second one carries this machine's path.
function agentsLines(nodeCmd = 'node', vlPath = VL_PATH) {
  const mark = `${quote(nodeCmd)} "${vlPath}" mark verify --agent codex`;
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

module.exports = {
  VL_PATH,
  MATCHER,
  HOOK_TIMEOUT_S,
  codexHome,
  hookCommand,
  ownGroups,
  isOwnCodexHandler,
  ownScriptPath,
  agentsLines,
  AGENTS_LINE_RE,
  agentsFile,
};
