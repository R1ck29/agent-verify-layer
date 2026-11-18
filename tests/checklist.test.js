'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Repo } = require('./helpers');

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

const ITEM = {
  id: 'stderr-notice',
  paths: ['src/hooks/**'],
  pattern: 'console\\.error',
  check: 'Is the notice on stdout?',
  why: 'stderr never reaches the model',
  incident: 'notice sat on stderr for months',
  owner: 'platform',
};

function seedWithChecklist(repo, items = [ITEM]) {
  repo.write('.claude/verification/checklist.json', JSON.stringify({ version: 1, items }));
  repo.write('src/hooks/h.js', 'ok();\n');
  repo.commit('init');
}

const context = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;

t('a matching item is handed to Claude as additionalContext (PostToolUse shape)', (repo) => {
  seedWithChecklist(repo);
  repo.write('src/hooks/h.js', 'ok();\nconsole.error("note");\n');
  const r = repo.verify();
  assert.equal(r.status, 0);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  const text = context(r);
  assert.match(text, /\[stderr-notice\]/);
  assert.match(text, /Is the notice on stdout\?/);
  assert.match(text, /stderr never reaches the model/); // reason is passed along
  assert.match(text, /notice sat on stderr for months/);
  assert.match(text, /platform/);
  assert.equal('decision' in r.json, false);
  assert.deepEqual(repo.ledger().find((x) => x.kind === 'run').fired, ['stderr-notice']);
});

t('UserPromptExpansion for /verify gets the same context with its own event name', (repo) => {
  seedWithChecklist(repo);
  repo.write('src/hooks/h.js', 'console.error(1);\n');
  const r = repo.verify('user');
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptExpansion');
  assert.match(context(r), /stderr-notice/);
});

t('no match -> no output at all', (repo) => {
  seedWithChecklist(repo);
  repo.write('src/hooks/h.js', 'ok();\nconsole.log("fine");\n'); // path matches, pattern does not
  const r = repo.verify();
  assert.equal(r.stdout, '');
  repo.write('other.js', 'console.error(1)\n'); // pattern matches, path does not
  assert.equal(repo.verify().stdout, '');
});

t('pattern is applied to added lines only, not removed ones', (repo) => {
  repo.write('.claude/verification/checklist.json', JSON.stringify({ items: [ITEM] }));
  repo.write('src/hooks/h.js', 'console.error("old");\nkeep();\n');
  repo.commit('init');
  repo.write('src/hooks/h.js', 'keep();\n'); // the console.error line is removed
  assert.equal(repo.verify().stdout, '');
});

t('the checklist is read from HEAD: working-tree edits have no effect', (repo) => {
  seedWithChecklist(repo);
  repo.write('src/hooks/h.js', 'console.error(1);\n');
  // Emptying the checklist in the working tree must not hide the HEAD item ...
  repo.write('.claude/verification/checklist.json', JSON.stringify({ items: [] }));
  assert.match(context(repo.verify()), /stderr-notice/);
  // ... and adding an item only in the working tree must not create one.
  repo.write('.claude/verification/checklist.json', JSON.stringify({ items: [ITEM, { ...ITEM, id: 'planted', pattern: '.*' }] }));
  const text = context(repo.verify());
  assert.match(text, /stderr-notice/);
  assert.doesNotMatch(text, /planted/);
});

t('touching the checks themselves adds a warning (and the ledger flags it)', (repo) => {
  seedWithChecklist(repo);
  repo.write('.claude/verification/checklist.json', JSON.stringify({ items: [] }));
  const r = repo.verify();
  assert.match(context(r), /警告/);
  assert.equal(repo.ledger().find((x) => x.kind === 'run').self_check_change, true);

  for (const file of ['CLAUDE.md', '.claude/skills/verify/SKILL.md', 'apps/web/CLAUDE.md', '.claude/hooks/x.js']) {
    const r2 = (() => {
      repo.write(file, 'x\n');
      return repo.verify();
    })();
    assert.match(context(r2), /警告/, file);
  }
});

t('a commit that touches the checks gets the warning back and self_check_change in the ledger', (repo) => {
  seedWithChecklist(repo);
  repo.write('CLAUDE.md', 'new rule\n');
  repo.commit('claude md');
  const r = repo.commitHook();
  assert.match(context(r), /警告/);
  assert.equal(repo.lastCommitRow().self_check_change, true);

  repo.write('src/x.js', 'x\n');
  repo.commit('plain');
  assert.equal(repo.commitHook('git commit -m plain').stdout, '');
});

t('missing checklist: silent, no warning rows', (repo) => {
  repo.write('src/a.js', 'x\n');
  repo.commit('init');
  repo.write('src/a.js', 'y\n');
  const r = repo.verify();
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(repo.ledger().find((x) => x.kind === 'run').checklist_warnings, undefined);
});

t('broken checklist JSON / invalid regex / malformed items: nothing emitted for them, only a count is kept', (repo) => {
  repo.write('.claude/verification/checklist.json', '{ this is not json');
  repo.write('src/hooks/h.js', 'x\n');
  repo.commit('init');
  repo.write('src/hooks/h.js', 'console.error(1)\n');
  let r = repo.verify();
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(repo.ledger().pop().checklist_warnings, 1);

  repo.write('.claude/verification/checklist.json', JSON.stringify({
    items: [
      { ...ITEM, id: 'bad-regex', pattern: '(' },
      { ...ITEM, id: 'no-why', why: undefined },
      { ...ITEM, id: 'paths-string', paths: 'src' },
      { ...ITEM, id: 'no-owner', owner: '' },
      42,
      null,
      ITEM,
    ],
  }));
  repo.commit('fix checklist');
  repo.write('src/hooks/h.js', 'console.error(2)\n');
  r = repo.verify();
  assert.equal(r.status, 0);
  const text = context(r);
  assert.match(text, /\[stderr-notice\]/);
  for (const bad of ['bad-regex', 'no-why', 'paths-string', 'no-owner']) assert.doesNotMatch(text, new RegExp(bad));
  assert.equal(repo.ledger().pop().checklist_warnings, 6);
});

t('untracked files are matched by their content; non-matching content does not fire', (repo) => {
  seedWithChecklist(repo);
  repo.write('src/hooks/new.js', 'fine();\n');
  assert.equal(repo.verify().stdout, '');
  repo.write('src/hooks/new.js', 'console.error("x");\n');
  assert.match(context(repo.verify()), /stderr-notice/);
});

t('an item without a pattern fires on any matching path; glob uses forward slashes', (repo) => {
  seedWithChecklist(repo, [{ ...ITEM, id: 'any-hook', pattern: undefined, paths: ['**/hooks/*.js'] }]);
  repo.write('src/hooks/h.js', 'changed();\n');
  assert.match(context(repo.verify()), /\[any-hook\]/);
});

t('code-review runs are recorded but never receive checklist context', (repo) => {
  seedWithChecklist(repo);
  repo.write('src/hooks/h.js', 'console.error(1);\n');
  const r = repo.codeReview();
  assert.equal(r.stdout, '');
  assert.equal(repo.ledger().find((x) => x.kind === 'run').skill, 'code-review');
});

t('at most 10 items are handed over and the text stays under the 10,000-character cap', (repo) => {
  const items = Array.from({ length: 15 }, (_, i) => ({ ...ITEM, id: `item-${i}`, pattern: undefined, check: 'c'.repeat(900), why: 'w'.repeat(200) }));
  seedWithChecklist(repo, items);
  repo.write('src/hooks/h.js', 'changed();\n');
  const text = context(repo.verify());
  assert.ok(text.length <= 10000, `length ${text.length}`);
  assert.equal((text.match(/\[item-\d+\]/g) || []).length <= 10, true);
});
