'use strict';
const { loadConfig } = require('./config');
const git = require('./git');
const ledger = require('./ledger');
const { classify, latestRun } = require('./classify');
const checklist = require('./checklist');
const { matchAny } = require('./glob');
const { quoteArg } = require('./shellquote');

const RECENT_COMMIT_S = 300;
const VL_PATH = require('node:path').resolve(__dirname, '..', 'vl.js');
const AGENTS = ['claude', 'codex'];
// Codex hooks have no `if`, so the commit hook sees every shell command: cheap pre-filter.
const COMMIT_RE = /\bgit\b[\s\S]*\bcommit\b/;

const now = () => Date.now() / 1000;

// "verify", "apps/web:verify" -> verify;  "review", "code-review" -> code-review
function kindFromName(name) {
  const last = String(name || '').split(':').pop().trim().toLowerCase();
  if (last === 'verify') return 'verify';
  if (last === 'code-review' || last === 'review') return 'code-review';
  return null;
}

function context(event, text) {
  return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;
}

function str(v) {
  return typeof v === 'string' && v ? v : undefined;
}

// Explicit --agent wins; otherwise `turn_id` (a Codex-only input field) means Codex.
// Environment variables are not used: Codex also sets CLAUDE_PLUGIN_ROOT for plugin hooks.
function resolveAgent(flag, input) {
  if (AGENTS.includes(flag)) return flag;
  return input && str(input.turn_id) ? 'codex' : 'claude';
}

// The command an agent runs once its checks pass (see lib/mark.js).
function markCommand(agent) {
  return `node ${quoteArg(VL_PATH, { always: true })} mark verify --agent ${agent}`;
}

function markHint(agent) {
  let cmd;
  try {
    cmd = markCommand(agent);
  } catch {
    return ''; // a path no shell can carry literally: no hint rather than a command that misfires
  }
  return `[verify-layer] verify の確認がすべて通ったら、コミットの前に次を実行して、確認した時点の状態を記録してください（記録だけで、作業は止めません。そのあとファイルを変えたら、確認と記録をやり直してください）: ${cmd}`;
}

// Records one verify / code-review run with the working-tree hash at this moment and, for verify,
// the HEAD-side checklist items that match the current diff. Shared by the hooks and `mark`.
// Returns { hits, selfCheck } (the caller decides what to show), or null outside a repo.
function recordRun(kind, cwd, { via, agent, session, cfg }) {
  const t0 = now();
  const opts = { timeout: cfg.timeoutMs };
  const root = git.repoRoot(cwd, opts);
  if (!root) return null;

  const tree = git.treeHash(root, opts);
  const changes = checklist.collectChanges(root, opts);
  const selfCheck = checklist.touchesChecks(changes);

  let hits = [];
  let warnings = 0;
  if (kind === 'verify') {
    const cl = checklist.loadChecklist(root, opts);
    warnings = cl.warnings;
    hits = checklist.matchItems(cl.items, changes, root);
  }

  // No snapshot, no row: a run without a tree would claim a verification of a state we cannot name.
  if (tree === null) return { root, tree, hits, selfCheck, written: false, snapshotFailed: true };

  const written = ledger.append(root, {
    kind: 'run',
    ts: t0,
    skill: kind,
    via,
    agent,
    tree,
    session,
    fired: hits.map((h) => h.item.id),
    self_check_change: selfCheck,
    ...(warnings ? { checklist_warnings: warnings } : {}),
    ms: Math.round((now() - t0) * 1000),
  });
  return { root, tree, hits, selfCheck, written };
}

// A verify / code-review run was started (by Claude via the Skill tool, or typed by the user).
function handleRun(kind, input, via, event, agent) {
  const cfg = loadConfig();
  if (cfg.mode === 'off') return null;
  const r = recordRun(kind, str(input.cwd) || process.cwd(), { via, agent, session: str(input.session_id), cfg });
  if (!r || kind !== 'verify') return null;
  const text = [checklist.formatContext(r.hits, r.selfCheck), cfg.markHint ? markHint(agent) : ''].filter(Boolean).join('\n');
  return context(event, text);
}

// PostToolUse(Skill). The hook has no `if` (`Skill(verify)` did not match on a real Claude Code
// 2.1.325), so every Skill call lands here: decide from tool_input.skill, and exit at once for
// anything that is not verify / code-review (including nested `apps/web:verify`).
function handleSkill(input, { agent } = {}) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const kind = kindFromName(str(ti.skill) || str(ti.name));
  return kind ? handleRun(kind, input, 'model', 'PostToolUse', resolveAgent(agent, input)) : null;
}

// UserPromptExpansion: the user typed /verify, /code-review or /review. `prompt` and
// `command_args` are never read, let alone stored.
function handleExpand(input, { agent } = {}) {
  const kind = kindFromName(input.command_name);
  if (!kind) return null;
  return handleRun(kind, input, 'user', 'UserPromptExpansion', resolveAgent(agent, input));
}

// Shell command text from a PostToolUse input. Claude and Codex both send tool_input.command as a
// string; an array or `cmd` is accepted defensively (unified exec shapes are not documented).
function commandText(input) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const c = ti.command !== undefined ? ti.command : ti.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return c.join(' ');
  return undefined;
}

// PostToolUse for a successful `git commit`: judge HEAD and append one ledger row.
function handleCommit(input, { agent: agentFlag } = {}) {
  const t0 = now();
  const agent = resolveAgent(agentFlag, input);
  const command = commandText(input);
  // Claude filters with `if: Bash(git commit *)`; Codex has no `if`, so filter here (a few ms).
  if (agent === 'codex' && !(typeof command === 'string' && COMMIT_RE.test(command))) return null;
  const cfg = loadConfig();
  if (cfg.mode === 'off') return null;
  const cwd = str(input.cwd) || process.cwd();
  const opts = { timeout: cfg.timeoutMs };
  const root = git.repoRoot(cwd, opts);
  if (!root) return null;
  const head = git.headInfo(root, opts);
  if (!head) return null;

  // `if` is best-effort: make sure this is a fresh commit we have not already recorded.
  const rows = ledger.readAll(root);
  if (rows.some((r) => r.kind === 'commit' && r.sha === head.sha)) return null;
  if (head.time !== null && now() - head.time > RECENT_COMMIT_S) return null;

  const paths = git.commitPaths(root, head, opts); // null = unreadable (judged "unknown")
  // Quoted text (commit messages) is stripped first so `-m "about --amend"` is not an amend.
  const amend =
    typeof command === 'string' && /(^|\s)--amend(\s|=|$)/.test(command.replace(/'[^']*'|"[^"]*"/g, ' '));
  const commitRows = rows.filter((r) => r.kind === 'commit');
  const prev = amend ? commitRows[commitRows.length - 2] : commitRows[commitRows.length - 1];
  const run = latestRun(rows, prev ? prev.ts : null);

  const verdict = classify({
    paths,
    run,
    skipGlobs: cfg.skipGlobs,
    diffNames: (tree) => git.diffTreeToHead(root, tree, opts),
  });
  const session = str(input.session_id);
  const sessionRan = (skill) => !!session && rows.some((r) => r.kind === 'run' && r.skill === skill && r.session === session);
  const selfCheck = !!paths && paths.some((p) => matchAny(checklist.SELF_CHECK_GLOBS, p));

  ledger.append(root, {
    kind: 'commit',
    ts: t0,
    sha: head.sha,
    mode: cfg.mode,
    agent,
    result: verdict.result,
    basis: run ? run.via || null : null,
    stale_files: verdict.stale_files,
    since_run_s: run ? Math.round(t0 - run.ts) : null,
    session_verify: sessionRan('verify'),
    session_code_review: sessionRan('code-review'),
    n_files: paths ? paths.length : null,
    self_check_change: selfCheck,
    session,
    ...(verdict.warn ? { warn: verdict.warn } : {}),
    ms: Math.round((now() - t0) * 1000),
  });
  return selfCheck ? context('PostToolUse', checklist.formatContext([], true)) : null;
}

module.exports = { kindFromName, resolveAgent, markCommand, recordRun, commandText, handleSkill, handleExpand, handleCommit, COMMIT_RE };
