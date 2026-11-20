'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { git, splitZ, hasHead } = require('./git');
const { matchAny, normalizePath } = require('./glob');

// The checklist is always read from HEAD (`git show`), never from the working tree,
// so a change under review cannot rewrite the checks that judge it.
const CHECKLIST_PATH = '.claude/verification/checklist.json';

// Changes that touch the checks themselves must be shown to a human.
const SELF_CHECK_GLOBS = [
  '.claude/verification/**',
  '**/CLAUDE.md',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks/**',
  'hooks/**',
  '**/.claude/skills/verify/**',
  '.claude/skills/verify/**',
  // Codex: the same checks live in AGENTS.md, the repo verify skill and project hooks.
  '**/AGENTS.md',
  '**/AGENTS.override.md',
  '**/.agents/skills/verify/**',
  '.agents/skills/verify/**',
  '.codex/hooks.json',
  '.codex/config.toml',
];

const MAX_ITEMS = 10;
const MAX_UNTRACKED_BYTES = 256 * 1024;
const MAX_CONTEXT_CHARS = 8000;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Returns { items, warnings, present }. Never throws. Invalid items are dropped
// and only counted (the ledger records the count, never the content).
function loadChecklist(cwd, opts) {
  const r = git(['show', `HEAD:${CHECKLIST_PATH}`], { cwd, ...opts });
  if (!r.ok) return { items: [], warnings: 0, present: false };
  let doc;
  try {
    doc = JSON.parse(r.out);
  } catch {
    return { items: [], warnings: 1, present: true };
  }
  const list = Array.isArray(doc) ? doc : doc && Array.isArray(doc.items) ? doc.items : null;
  if (!list) return { items: [], warnings: 1, present: true };

  const items = [];
  let warnings = 0;
  for (const raw of list) {
    const ok =
      raw &&
      typeof raw === 'object' &&
      isNonEmptyString(raw.id) &&
      Array.isArray(raw.paths) &&
      raw.paths.length > 0 &&
      raw.paths.every(isNonEmptyString) &&
      isNonEmptyString(raw.check) &&
      isNonEmptyString(raw.why) &&
      isNonEmptyString(raw.owner) &&
      (raw.pattern === undefined || isNonEmptyString(raw.pattern)) &&
      (raw.incident === undefined || typeof raw.incident === 'string');
    if (!ok) {
      warnings++;
      continue;
    }
    let re = null;
    if (raw.pattern !== undefined) {
      try {
        re = new RegExp(raw.pattern);
      } catch {
        warnings++;
        continue;
      }
    }
    items.push({
      id: raw.id,
      paths: raw.paths.map(normalizePath),
      re,
      check: raw.check,
      why: raw.why,
      owner: raw.owner,
      incident: raw.incident || '',
    });
  }
  return { items, warnings, present: true };
}

// Parses `git diff -U0` output into Map<path, addedLines[]>.
function parseAddedLines(diffText) {
  const added = new Map();
  let file = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\r$/, '');
      if (p === '/dev/null') file = null;
      else file = p.replace(/^"?b\//, '').replace(/"$/, '');
      if (file && !added.has(file)) added.set(file, []);
    } else if (line.startsWith('--- ')) {
      // a deleted file has no "+++" target; nothing to collect
    } else if (line.startsWith('+') && file) {
      added.get(file).push(line.slice(1));
    }
  }
  return added;
}

// What changed in the working tree relative to HEAD: tracked edits (staged or not)
// plus untracked files. Returns { names:Set, addedFor(path), untracked:Set }.
// Added lines are fetched per file, with a literal pathspec, only for files an item with a
// pattern asks about: a combined `git diff` mixes the path (which may hold spaces or quotes) into
// a header line that cannot be parsed back reliably (XREVIEW #10).
function collectChanges(cwd, opts) {
  const names = new Set();
  const tracked = hasHead(cwd, opts);
  if (tracked) {
    const n = git(['diff', 'HEAD', '--name-only', '--no-renames', '-z'], { cwd, ...opts });
    if (n.ok) splitZ(n.out).forEach((p) => names.add(p));
  } else {
    const l = git(['ls-files', '-z'], { cwd, ...opts });
    if (l.ok) splitZ(l.out).forEach((p) => names.add(p));
  }
  const u = git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd, ...opts });
  const untracked = u.ok ? splitZ(u.out) : [];
  untracked.forEach((p) => names.add(p));
  const cache = new Map();
  const addedFor = (p) => {
    if (cache.has(p)) return cache.get(p);
    let lines = [];
    if (tracked) {
      const d = git(['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-renames', '-U0', '--', `:(literal)${p}`], { cwd, ...opts });
      if (d.ok) {
        // One file with -U0: the only header line starting with "+++ " is the first one; an added
        // line whose text starts with "++ " is real content.
        const all = d.out.split('\n');
        const start = all.findIndex((l) => l.startsWith('+++ '));
        lines = all.slice(start + 1).filter((l) => l.startsWith('+')).map((l) => l.slice(1));
      }
    }
    cache.set(p, lines);
    return lines;
  };
  return { names, addedFor, untracked: new Set(untracked) };
}

function readUntracked(root, rel) {
  try {
    const file = path.join(root, rel);
    // lstat: a symlink (possibly pointing outside the repository) is never read.
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function touchesChecks(changes) {
  return [...changes.names].some((p) => matchAny(SELF_CHECK_GLOBS, p));
}

// Returns the items whose paths match a changed file and, when a pattern is given,
// whose pattern matches an added line (or any line of an untracked file).
function matchItems(items, changes, root) {
  const hits = [];
  for (const item of items) {
    const files = [...changes.names].filter((p) => matchAny(item.paths, p));
    if (!files.length) continue;
    if (item.re) {
      const found = files.some((p) => {
        if (changes.untracked.has(p)) {
          const text = readUntracked(root, p);
          return text !== null && text.split('\n').some((l) => item.re.test(l));
        }
        return changes.addedFor(p).some((l) => item.re.test(l));
      });
      if (!found) continue;
    }
    hits.push({ item, files });
    if (hits.length >= MAX_ITEMS) break;
  }
  return hits;
}

// Text handed to Claude as additionalContext. Empty string when there is nothing to say.
// `when` says where the agent should check the items: inside verify (hook) or before committing (mark).
// The self-check warning goes first and is never cut: only the item list is shortened to fit.
function formatContext(hits, selfCheck, when = 'verify の中で') {
  const warning = selfCheck
    ? '[verify-layer] 警告: この変更はチェック自体（チェックリスト、CLAUDE.md・AGENTS.md、hooks、設定、verify スキル）を触っています。判定の基準を変える変更なので、利用者に内容を見せて確認を求めてください。'
    : '';
  const lines = [];
  if (hits.length) {
    lines.push(`[verify-layer] 次の確認項目が今回の変更に当たりました（HEAD 側の .claude/verification/checklist.json 由来）。${when}確認してください。`);
    for (const { item, files } of hits) {
      const shown = files.slice(0, 3).join(', ') + (files.length > 3 ? ` ほか${files.length - 3}件` : '');
      const parts = [`- [${item.id}] ${item.check}`, `  理由: ${item.why}`];
      if (item.incident) parts.push(`  元の事故: ${item.incident}`);
      parts.push(`  担当: ${item.owner} / 該当: ${shown}`);
      lines.push(parts.join('\n'));
    }
  }
  let body = lines.join('\n');
  const room = MAX_CONTEXT_CHARS - (warning ? warning.length + 1 : 0);
  if (body.length > room) body = body.slice(0, Math.max(0, room - 8)) + '\n…（省略）';
  return [warning, body].filter(Boolean).join('\n');
}

module.exports = {
  CHECKLIST_PATH,
  SELF_CHECK_GLOBS,
  loadChecklist,
  parseAddedLines,
  collectChanges,
  touchesChecks,
  matchItems,
  formatContext,
};
