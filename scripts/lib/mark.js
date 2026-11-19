'use strict';
// `vl.js mark verify`: run by the agent (or a person) right after the verify checks passed.
// Records the working-tree hash at that moment as a verify run (`via: "mark"`), so a commit is
// judged against the state that was actually checked, not the state when verify was loaded.
// Older readers see an ordinary verify run row, so ledgers stay backward compatible.
// Never fails the caller's work: outside a repo or with mode=off it explains and exits 0.
const path = require('node:path');
const { loadConfig } = require('./config');
const { recordRun } = require('./hooks');
const checklist = require('./checklist');

const AGENTS = ['claude', 'codex'];

// Session ids the agents expose to shell commands. CLAUDE_CODE_SESSION_ID matches the hook
// `session_id` (Claude Code changelog). CODEX_THREAD_ID is not documented: used only if present.
function sessionFromEnv(agent, env) {
  const v = agent === 'codex' ? env.CODEX_THREAD_ID : agent === 'claude' ? env.CLAUDE_CODE_SESSION_ID : undefined;
  return typeof v === 'string' && v ? v : undefined;
}

function detectAgent(flag, env) {
  if (AGENTS.includes(flag)) return flag;
  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE === '1') return 'claude';
  if (env.CODEX_THREAD_ID) return 'codex';
  return undefined;
}

function run(flags, env = process.env) {
  const [what] = flags._;
  if (what !== 'verify') {
    process.stderr.write('usage: vl.js mark verify [--agent claude|codex] [--repo DIR]\n');
    return 2;
  }
  if (flags.agent !== undefined && !AGENTS.includes(flags.agent)) {
    process.stderr.write('--agent は claude か codex です\n');
    return 2;
  }
  const cfg = loadConfig();
  if (cfg.mode === 'off') {
    process.stdout.write('[verify-layer] mode=off のため記録しません\n');
    return 0;
  }
  const agent = detectAgent(flags.agent, env);
  const cwd = path.resolve(flags.repo || process.cwd());
  let r = null;
  try {
    r = recordRun('verify', cwd, { via: 'mark', agent, session: sessionFromEnv(agent, env), cfg });
  } catch (e) {
    process.stderr.write(`[verify-layer] 記録できませんでした: ${String(e && e.message).split('\n')[0]}\n`);
    return 0;
  }
  if (!r) {
    process.stderr.write(`[verify-layer] git リポジトリではないため記録しません: ${cwd}\n`);
    return 0;
  }
  if (r.snapshotFailed) {
    process.stderr.write('[verify-layer] 記録できませんでした: 作業ツリーのスナップショット（git add -A）に失敗しました（コミット前の空のリポジトリがツリー内にある、読めないファイルがある等）。作業は続けてかまいません\n');
    return 0;
  }
  if (!r.written) {
    process.stderr.write('[verify-layer] 台帳に書き込めませんでした（.git が読み取り専用など）。作業は続けてかまいません\n');
    return 0;
  }
  const lines = [
    `[verify-layer] 確認した時点の状態を記録しました（tree ${String(r.tree || '?').slice(0, 12)}）。このあとファイルを変えたら、確認をやり直してから、もう一度 mark してください。`,
  ];
  const text = checklist.formatContext(r.hits, r.selfCheck, 'コミットの前に');
  if (text) lines.push(text);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

module.exports = { run, sessionFromEnv, detectAgent };
