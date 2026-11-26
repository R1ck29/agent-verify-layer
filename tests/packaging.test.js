'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, Repo } = require('./helpers');
const { loadChecklist } = require('../scripts/lib/checklist');

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const json = (...p) => JSON.parse(read(...p));

test('distribution manifests agree on version 0.2.0 and there is no LICENSE (private)', () => {
  const v = read('VERSION').trim();
  assert.equal(v, '0.2.0');
  assert.equal(json('package.json').version, v);
  assert.equal(json('.claude-plugin', 'plugin.json').version, v);
  const mp = json('.claude-plugin', 'marketplace.json');
  assert.equal(mp.metadata.version, v);
  assert.equal(mp.plugins[0].version, v);
  assert.equal(mp.plugins[0].name, json('.claude-plugin', 'plugin.json').name);
  assert.equal(mp.plugins[0].source, './');
  assert.equal(json('package.json').private, true);
  for (const f of fs.readdirSync(ROOT)) assert.doesNotMatch(f, /^LICENSE/i);
  assert.equal(json('.claude-plugin', 'plugin.json').license, undefined);
});

test('no npm dependencies and v0.2 has a separate verify2 skill', () => {
  const pkg = json('package.json');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(fs.existsSync(path.join(ROOT, 'skills', 'verify')), false);
  assert.match(read('skills', 'verify2', 'SKILL.md'), /^name: verify2$/m);
  for (const f of ['scripts/vl.js', 'scripts/install.js']) {
    const src = read(f);
    for (const m of src.matchAll(/require\('([^']+)'\)/g)) assert.ok(m[1].startsWith('node:') || m[1].startsWith('.'), `${f} requires ${m[1]}`);
  }
});

test('hooks.json follows the hooks reference: exec form, one `if` per handler, tool events only', () => {
  const { hooks } = json('hooks', 'hooks.json');
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'UserPromptExpansion']);
  assert.equal(JSON.stringify(hooks).includes('PreToolUse'), false); // observe mode never gates
  let handlers = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        handlers++;
        assert.equal(h.type, 'command');
        assert.equal(h.command, 'node');
        assert.ok(Array.isArray(h.args) && h.args[0] === '${CLAUDE_PLUGIN_ROOT}/scripts/vl.js' && h.args[1] === 'hook');
        assert.equal(h.onFailure, 'continue');
        assert.ok(h.timeout > 0 && h.timeout <= 10);
        if (h.if !== undefined) {
          assert.equal(event, 'PostToolUse'); // `if` never runs on other events
          assert.equal(typeof h.if, 'string');
          assert.doesNotMatch(h.if, /&&|\|\|/); // exactly one rule
        }
        assert.equal('decision' in h, false);
      }
    }
  }
  assert.equal(handlers, 4);
  const post = hooks.PostToolUse;
  const skill = post.find((g) => g.matcher === 'Skill');
  // `if: Skill(verify)` did not match on a real 2.1.325: the Skill hook must stay `if`-free and decide in the script
  assert.deepEqual(skill.hooks.map((h) => [h.if, h.args[2]]), [[undefined, 'skill']]);
  const bash = post.find((g) => g.matcher === 'Bash|PowerShell');
  assert.deepEqual(bash.hooks.map((h) => h.if).sort(), ['Bash(git commit *)', 'PowerShell(git commit *)']);
  // the UserPromptExpansion matcher is a regex and must cover nested and aliased names
  const re = new RegExp(hooks.UserPromptExpansion[0].matcher);
  for (const name of ['verify', 'apps/web:verify', 'code-review', 'review', 'x:code-review']) assert.equal(re.test(name), true, name);
  for (const name of ['simplify', 'verify-all', 'reviewer', 'preview']) assert.equal(re.test(name), false, name);
});

test('rules/verification.md has exactly the two rule lines', () => {
  const bullets = read('rules', 'verification.md').split('\n').filter((l) => l.startsWith('- '));
  assert.equal(bullets.length, 2);
  assert.match(bullets[0], /flaky/);
  assert.match(bullets[1], /3 回続けて失敗/);
  assert.doesNotMatch(read('rules', 'verification.md'), /Opus/);
});

test('examples/checklist.json loads from HEAD with zero warnings and all regexes compile', () => {
  const repo = new Repo();
  try {
    repo.write('.claude/verification/checklist.json', read('examples', 'checklist.json'));
    repo.commit('add checklist');
    const cl = loadChecklist(repo.dir);
    assert.equal(cl.present, true);
    assert.equal(cl.warnings, 0);
    assert.equal(cl.items.length, 7);
    for (const it of cl.items) {
      assert.ok(it.owner && it.why && it.check, it.id);
      assert.ok(it.re instanceof RegExp, it.id);
    }
    assert.equal(new Set(cl.items.map((i) => i.id)).size, cl.items.length);
  } finally {
    repo.cleanup();
  }
});

test('plugin and marketplace manifests have their expected local registration fields', () => {
  const plugin = json('.claude-plugin', 'plugin.json');
  const marketplace = json('.claude-plugin', 'marketplace.json');
  assert.ok(plugin.name && plugin.description && plugin.author.name);
  assert.ok(marketplace.name && marketplace.owner.name && marketplace.metadata.description);
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.equal(marketplace.plugins[0].source, './');
});
