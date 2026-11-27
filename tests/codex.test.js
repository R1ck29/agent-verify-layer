'use strict';
// Codex adapter: Codex-shaped PostToolUse input (fixtures/codex) through `vl.js hook commit --agent codex`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Repo, VL, run } = require('./helpers');
const codex = require('../scripts/lib/codex');
const { commandText, resolveAgent, COMMIT_RE } = require('../scripts/lib/hooks');

const FIX = path.join(__dirname, 'fixtures', 'codex');
const fixture = (name, repo, patch = {}) => ({
  ...JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8')),
  cwd: repo.dir,
  ...(name === 'post-tool-use-git-commit.json' ? { tool_response: { output: repo.commitOutput } } : {}),
  ...patch,
});

function t(name, fn) {
  test(name, async () => {
    const repo = new Repo();
    try {
      await fn(repo);
    } finally {
      repo.cleanup();
    }
  });
}

function seed(repo) {
  repo.write('src/a.js', 'one\n');
  repo.commit('init');
}

// The hook payload is sent as-is (helpers.hook adds session_id/cwd only for objects, so stringify).
const codexHook = (repo, input, args = ['commit', '--agent', 'codex']) => repo.hook(args, JSON.stringify(input));

t('Codex PostToolUse(Bash) for git commit writes one commit row with agent codex', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  repo.commit('change greeting');
  const r = codexHook(repo, fixture('post-tool-use-git-commit.json', repo));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  const row = repo.lastCommitRow();
  assert.equal(row.agent, 'codex');
  assert.equal(row.result, 'none');
  assert.equal(row.session, '019a0000-0000-7000-8000-000000000001');
  assert.equal(row.sha, repo.git('rev-parse', 'HEAD'));
  // Codex launches matching hooks concurrently and may deliver PostToolUse late: a second
  // delivery for the same HEAD is not recorded twice.
  codexHook(repo, fixture('post-tool-use-git-commit.json', repo));
  assert.equal(repo.ledger().filter((x) => x.kind === 'commit').length, 1);
});

t('Codex: non-commit shell commands exit 0 at once and never touch the ledger', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  repo.commit('made outside the agent'); // a fresh, unrecorded HEAD
  for (const cmd of ['node check.js', 'ls -la', 'echo commit', 'git status']) {
    const r = codexHook(repo, fixture('post-tool-use-other-command.json', repo, { tool_input: { command: cmd } }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(repo.ledger(), []);
});

t('Codex: verify skill + mark, then commit -> verified (basis mark, agent codex)', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  const m = run(process.execPath, [VL, 'mark', 'verify', '--agent', 'codex'], { cwd: repo.dir, env: repo.env });
  assert.equal(m.status, 0, m.stderr);
  repo.commit('c');
  codexHook(repo, fixture('post-tool-use-git-commit.json', repo));
  const row = repo.lastCommitRow();
  assert.equal(row.result, 'verified');
  assert.equal(row.basis, 'mark');
  assert.equal(row.agent, 'codex');
});

t('without --agent, turn_id marks the input as Codex; Claude input stays claude', (repo) => {
  seed(repo);
  repo.write('src/a.js', 'two\n');
  repo.commit('c');
  codexHook(repo, fixture('post-tool-use-git-commit.json', repo), ['commit']);
  assert.equal(repo.lastCommitRow().agent, 'codex');
  repo.write('src/a.js', 'three\n');
  repo.commit('c2');
  repo.commitHook();
  assert.equal(repo.lastCommitRow().agent, 'claude');
});

t('Codex: a commit touching AGENTS.md or the repo verify skill is flagged as changing the checks', (repo) => {
  seed(repo);
  repo.write('AGENTS.md', '- rule\n');
  repo.write('.agents/skills/verify/SKILL.md', '---\nname: verify\ndescription: d\n---\n');
  repo.commit('checks');
  const r = codexHook(repo, fixture('post-tool-use-git-commit.json', repo));
  assert.equal(repo.lastCommitRow().self_check_change, true);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(typeof r.json.hookSpecificOutput.additionalContext, 'string');
  assert.equal('decision' in r.json, false);
});

test('commandText / COMMIT_RE / resolveAgent', () => {
  assert.equal(commandText({ tool_input: { command: 'git commit -m x' } }), 'git commit -m x');
  assert.equal(commandText({ tool_input: { command: ['git', 'commit'] } }), 'git commit');
  assert.equal(commandText({ tool_input: { cmd: 'git commit' } }), 'git commit');
  assert.equal(commandText({ tool_input: { command: 3 } }), undefined);
  assert.equal(commandText({}), undefined);
  for (const c of ['git commit -m x', 'git -C sub commit -am y', 'git add . && git commit --amend --no-edit']) assert.ok(COMMIT_RE.test(c), c);
  for (const c of ['node check.js', 'echo commit', 'gitk', 'git status']) assert.ok(!COMMIT_RE.test(c), c);
  assert.equal(resolveAgent('codex', {}), 'codex');
  assert.equal(resolveAgent('bogus', { turn_id: 't' }), 'codex');
  assert.equal(resolveAgent(undefined, { session_id: 's' }), 'claude');
});

test('Codex hook definition: one PostToolUse ^Bash$ command string with an explicit short timeout', () => {
  const groups = codex.ownGroups('node', '/opt/vl layer/scripts/vl.js');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].event, 'PostToolUse');
  assert.equal(groups[0].group.matcher, '^Bash$');
  const h = groups[0].group.hooks[0];
  assert.equal(h.command, 'node "/opt/vl layer/scripts/vl.js" hook commit --agent codex');
  assert.equal(h.timeout, 10);
  for (const k of ['args', 'if', 'onFailure']) assert.equal(k in h, false); // not in Codex's schema
  assert.ok(codex.isOwnCodexHandler(h));
  assert.equal(codex.ownScriptPath(h), '/opt/vl layer/scripts/vl.js');
  assert.equal(codex.hookCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\vl\\scripts\\vl.js'), '"C:\\Program Files\\nodejs\\node.exe" "C:\\vl\\scripts\\vl.js" hook commit --agent codex');
  assert.throws(() => codex.hookCommand('node', '/a\nb/vl.js'));
  // foreign handlers that merely mention vl.js are not ours
  for (const command of ['node /x/vl.js hook commit', 'echo "vl.js hook commit --agent codex"', 'python3 "/x/vl.js" hook commit --agent claude']) {
    assert.equal(codex.isOwnCodexHandler({ type: 'command', command }), false, command);
  }
});
