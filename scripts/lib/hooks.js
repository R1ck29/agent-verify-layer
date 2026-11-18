'use strict';
const { loadConfig } = require('./config');
const git = require('./git');
const ledger = require('./ledger');
const { classify, latestRun } = require('./classify');
const checklist = require('./checklist');
const { matchAny } = require('./glob');

const RECENT_COMMIT_S = 300;

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

// A verify / code-review run was started (by Claude via the Skill tool, or typed by the user).
// Records the working-tree hash at that moment; for verify, also hands back the checklist items
// that match the current diff. Returns a hook JSON object or null.
function handleRun(kind, input, via, event) {
  const t0 = now();
  const cfg = loadConfig();
  if (cfg.mode === 'off') return null;
  const cwd = str(input.cwd) || process.cwd();
  const root = git.repoRoot(cwd, { timeout: cfg.timeoutMs });
  if (!root) return null;
  const opts = { timeout: cfg.timeoutMs };

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

  ledger.append(root, {
    kind: 'run',
    ts: t0,
    skill: kind,
    via,
    tree,
    session: str(input.session_id),
    fired: hits.map((h) => h.item.id),
    self_check_change: selfCheck,
    ...(warnings ? { checklist_warnings: warnings } : {}),
    ms: Math.round((now() - t0) * 1000),
  });
  return context(event, kind === 'verify' ? checklist.formatContext(hits, selfCheck) : '');
}

// PostToolUse(Skill). The hook has no `if` (`Skill(verify)` did not match on a real Claude Code
// 2.1.325), so every Skill call lands here: decide from tool_input.skill, and exit at once for
// anything that is not verify / code-review (including nested `apps/web:verify`).
function handleSkill(input) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const kind = kindFromName(str(ti.skill) || str(ti.name));
  return kind ? handleRun(kind, input, 'model', 'PostToolUse') : null;
}

// UserPromptExpansion: the user typed /verify, /code-review or /review. `prompt` and
// `command_args` are never read, let alone stored.
function handleExpand(input) {
  const kind = kindFromName(input.command_name);
  if (!kind) return null;
  return handleRun(kind, input, 'user', 'UserPromptExpansion');
}

// PostToolUse for a successful `git commit`: judge HEAD and append one ledger row.
function handleCommit(input) {
  const t0 = now();
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

  const paths = git.commitPaths(root, head, opts) || [];
  const command = input.tool_input && input.tool_input.command;
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
  const selfCheck = paths.some((p) => matchAny(checklist.SELF_CHECK_GLOBS, p));

  ledger.append(root, {
    kind: 'commit',
    ts: t0,
    sha: head.sha,
    mode: cfg.mode,
    result: verdict.result,
    stale_files: verdict.stale_files,
    since_run_s: run ? Math.round(t0 - run.ts) : null,
    session_verify: sessionRan('verify'),
    session_code_review: sessionRan('code-review'),
    n_files: paths.length,
    self_check_change: selfCheck,
    session,
    ...(verdict.warn ? { warn: verdict.warn } : {}),
    ms: Math.round((now() - t0) * 1000),
  });
  return selfCheck ? context('PostToolUse', checklist.formatContext([], true)) : null;
}

module.exports = { kindFromName, handleSkill, handleExpand, handleCommit };
