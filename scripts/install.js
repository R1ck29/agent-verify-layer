#!/usr/bin/env node
'use strict';
// settings.json merger for environments where the plugin cannot be used.
//   node scripts/install.js [--check] [--scope user|project] [--json]     read-only (default)
//   node scripts/install.js --apply     [--mode observe|off] [--rules]
//   node scripts/install.js --uninstall [--rules] [--purge]
// Other options: --settings-file PATH, --project-dir DIR, --node PATH, --force
// Own hooks are recognised by the vl.js path in their args (see lib/settings.js);
// foreign hooks are never edited, removed or reordered.
const fs = require('node:fs');
const path = require('node:path');
const { claudeDir, configDir, configPath } = require('./lib/config');
const { repoRoot } = require('./lib/git');
const { isOwnHandler, readJsonFile, managedSettingsPath } = require('./lib/settings');

const ROOT = path.resolve(__dirname, '..');
const VL = path.join(ROOT, 'scripts', 'vl.js');
const RULES_SRC = path.join(ROOT, 'rules', 'verification.md');

// --- pure helpers (exported for tests) -------------------------------------------------

// Groups from hooks/hooks.json with ${CLAUDE_PLUGIN_ROOT} replaced by this checkout's absolute path.
function buildOwnGroups(nodeCmd) {
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  // path.normalize gives native separators (the template uses "/"), so Windows paths are not mixed.
  const sub = (s) => (typeof s === 'string' && s.includes('${CLAUDE_PLUGIN_ROOT}') ? path.normalize(s.split('${CLAUDE_PLUGIN_ROOT}').join(ROOT)) : s);
  const out = [];
  for (const [event, groups] of Object.entries(tpl.hooks)) {
    for (const g of groups) {
      out.push({
        event,
        group: {
          ...(g.matcher !== undefined ? { matcher: g.matcher } : {}),
          hooks: g.hooks.map((h) => ({
            ...h,
            command: h.command === 'node' ? nodeCmd : sub(h.command),
            ...(h.args ? { args: h.args.map(sub) } : {}),
          })),
        },
      });
    }
  }
  return out;
}

// Returns { settings, removed } without mutating the input.
function removeOwn(settings) {
  const next = JSON.parse(JSON.stringify(settings));
  let removed = 0;
  if (!next.hooks || typeof next.hooks !== 'object') return { settings: next, removed };
  for (const event of Object.keys(next.hooks)) {
    const groups = next.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const handlers = g.hooks.filter((h) => !isOwnHandler(h));
      const gone = g.hooks.length - handlers.length;
      removed += gone;
      if (gone && handlers.length === 0) continue; // the group only existed for us
      kept.push(gone ? { ...g, hooks: handlers } : g);
    }
    if (kept.length) next.hooks[event] = kept;
    else if (groups.length) delete next.hooks[event]; // we emptied it
  }
  if (removed && Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, removed };
}

function addOwn(settings, ownGroups) {
  const next = JSON.parse(JSON.stringify(settings));
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) next.hooks = {};
  for (const { event, group } of ownGroups) {
    if (!Array.isArray(next.hooks[event])) next.hooks[event] = [];
    next.hooks[event].push(group);
  }
  return next;
}

function describeGroups(groups) {
  return groups.flatMap(({ event, group }) =>
    group.hooks.map((h) => `${event}${group.matcher ? ` [${group.matcher}]` : ''} ${h.if ? `if=${h.if}` : '(if なし)'} → ${(h.args || []).slice(-3).join(' ')}`));
}

function indentOf(text) {
  const m = /^([ \t]+)"/m.exec(text || '');
  return m ? m[1] : '  ';
}

// --- file operations ---------------------------------------------------------------------

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Writes through symlinks (dotfile managers) and keeps the original file mode.
function atomicWrite(file, text) {
  let target = file;
  let mode;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    /* new file */
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.vl-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

// Never overwrites an earlier backup, even within the same second.
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const base = `${file}.verify-layer-backup-${timestamp()}`;
  for (let n = 0; n < 1000; n++) {
    const dest = n === 0 ? base : `${base}-${n}`;
    try {
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('バックアップの名前を決められません');
}

function isWritable(file) {
  // A new file needs write access to its nearest existing ancestor directory.
  let p = file;
  while (!fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveTargets(opts) {
  const scope = opts.scope || 'user';
  if (!['user', 'project'].includes(scope)) throw new Error(`--scope は user か project です: ${scope}`);
  const projectDir = path.resolve(opts.projectDir || repoRoot(process.cwd()) || process.cwd());
  // The hook path is machine-specific, so project scope uses the git-ignored local file.
  const settingsFile = opts.settingsFile
    ? path.resolve(opts.settingsFile)
    : scope === 'user'
      ? path.join(claudeDir(), 'settings.json')
      : path.join(projectDir, '.claude', 'settings.local.json');
  const rulesFile = scope === 'user' ? path.join(claudeDir(), 'rules', 'verification.md') : path.join(projectDir, '.claude', 'rules', 'verification.md');
  return { scope, settingsFile, rulesFile };
}

function managedBlocks() {
  const m = readJsonFile(managedSettingsPath());
  return !!(m.data && m.data.allowManagedHooksOnly === true);
}

// --- main ----------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { action: 'check' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.action = 'check';
    else if (a === '--apply') o.action = 'apply';
    else if (a === '--uninstall') o.action = 'uninstall';
    else if (a === '--scope') o.scope = argv[++i];
    else if (a === '--settings-file') o.settingsFile = argv[++i];
    else if (a === '--project-dir') o.projectDir = argv[++i];
    else if (a === '--mode') o.mode = argv[++i];
    else if (a === '--node') o.node = argv[++i];
    else if (a === '--rules') o.rules = true;
    else if (a === '--purge') o.purge = true;
    else if (a === '--force') o.force = true;
    else if (a === '--json') o.json = true;
    else throw new Error(`不明なオプション: ${a}`);
  }
  if (o.mode !== undefined && !['observe', 'off'].includes(o.mode)) throw new Error('--mode は observe か off です（enforce は v0.1 にありません）');
  return o;
}

function run(opts) {
  const t = resolveTargets(opts);
  const report = { action: opts.action, scope: t.scope, settingsFile: t.settingsFile, changes: [], notes: [], wrote: [] };
  const read = readJsonFile(t.settingsFile);
  if (read.error) {
    report.error = `${t.settingsFile} を読めません（${read.error}）。何も書いていません。JSON として直してから再実行してください`;
    return { code: 2, report };
  }
  const before = read.data || {};
  const nodeCmd = opts.node || 'node';
  const ownGroups = buildOwnGroups(nodeCmd);
  const { settings: stripped, removed } = removeOwn(before);
  report.installedHandlers = removed;
  report.foreignHandlers = (() => {
    let n = 0;
    for (const groups of Object.values(stripped.hooks || {})) for (const g of groups || []) n += Array.isArray(g && g.hooks) ? g.hooks.length : 0;
    return n;
  })();

  const after = opts.action === 'uninstall' ? stripped : addOwn(stripped, ownGroups);
  const same = JSON.stringify(after) === JSON.stringify(before);
  report.upToDate = same;
  if (opts.action === 'check') {
    report.status = removed === 0 ? 'not-installed' : same ? 'installed' : 'outdated';
    if (!same) report.changes = describeGroups(ownGroups);
    report.notes.push(`既存の hook ${report.foreignHandlers} 件は変更しません`);
    if (managedBlocks()) report.notes.push('管理設定の allowManagedHooksOnly が有効です。--apply しても hook は動きません（管理者向けの配布が必要）');
    const cfg = readJsonFile(configPath());
    report.config = cfg.exists ? (cfg.data ? `mode=${cfg.data.mode}` : '読めません') : '未作成（--apply で {"mode":"observe"} を作成）';
    report.rules = fs.existsSync(t.rulesFile) ? `あり: ${t.rulesFile}` : `なし（--rules で ${t.rulesFile} に置く）`;
    return { code: 0, report };
  }

  if (opts.action === 'apply') {
    if (managedBlocks() && !opts.force) {
      report.error = '管理設定の allowManagedHooksOnly が有効なため、hook は動きません。書き込みを中止しました（--force で無視できます）。管理者に hooks/hooks.json を管理設定で配布してもらってください';
      return { code: 3, report };
    }
    report.changes = describeGroups(ownGroups);
  } else {
    report.changes = removed ? [`自分の hook ${removed} 件を外す`] : [];
  }

  if (!same) {
    if (!isWritable(t.settingsFile)) {
      report.error = `${t.settingsFile} に書き込めません（読み取り専用）。何も書いていません`;
      return { code: 2, report };
    }
    const b = backup(t.settingsFile);
    if (b) report.wrote.push(`バックアップ: ${b}`);
    if (opts.action === 'uninstall' && Object.keys(after).length === 0 && !fs.lstatSync(t.settingsFile).isSymbolicLink()) {
      fs.unlinkSync(fs.realpathSync(t.settingsFile)); // we emptied it: nothing else lived there
      report.wrote.push(`削除: ${t.settingsFile}（空になったため。バックアップあり）`);
    } else {
      atomicWrite(t.settingsFile, JSON.stringify(after, null, indentOf(read.text)) + '\n');
      report.wrote.push(`更新: ${t.settingsFile}`);
    }
  } else {
    report.notes.push('settings は既に目的の状態です（書き込みなし）');
  }

  if (opts.action === 'apply') {
    const cfg = readJsonFile(configPath());
    if (!cfg.exists || opts.mode) {
      const data = { ...(cfg.data || {}) };
      data.mode = opts.mode || data.mode || 'observe';
      atomicWrite(configPath(), JSON.stringify(data, null, 2) + '\n');
      report.wrote.push(`設定: ${configPath()}（mode=${data.mode}）`);
    }
    if (opts.rules) handleRulesApply(t, opts, report);
  } else {
    if (opts.rules) handleRulesRemove(t, report);
    if (opts.purge) purgeConfig(report);
    report.notes.push('各リポジトリの台帳（.git/claude-verify/）は残しています。消すかどうかは利用者が決めてください');
  }
  return { code: 0, report };
}

function handleRulesApply(t, opts, report) {
  const src = fs.readFileSync(RULES_SRC, 'utf8');
  if (fs.existsSync(t.rulesFile) && fs.readFileSync(t.rulesFile, 'utf8') !== src && !opts.force) {
    report.notes.push(`${t.rulesFile} は別の内容で既にあるため上書きしませんでした（--force で上書き）`);
    return;
  }
  atomicWrite(t.rulesFile, src);
  report.wrote.push(`Rules: ${t.rulesFile}`);
}

function handleRulesRemove(t, report) {
  try {
    if (fs.readFileSync(t.rulesFile, 'utf8') === fs.readFileSync(RULES_SRC, 'utf8')) {
      fs.unlinkSync(t.rulesFile);
      report.wrote.push(`削除: ${t.rulesFile}`);
    } else {
      report.notes.push(`${t.rulesFile} は編集済みのため残しました`);
    }
  } catch {
    /* no rules file */
  }
}

function purgeConfig(report) {
  try {
    fs.rmSync(configPath(), { force: true });
    fs.rmdirSync(configDir());
    report.wrote.push(`削除: ${configDir()}`);
  } catch {
    /* directory not empty or absent */
  }
}

function printReport(r) {
  const L = [];
  const label = { check: '確認（読むだけ）', apply: '導入', uninstall: '削除' }[r.action];
  L.push(`verify-layer install — ${label} / scope=${r.scope}`);
  L.push(`対象: ${r.settingsFile}`);
  if (r.error) L.push(`エラー: ${r.error}`);
  if (r.status) L.push(`状態: ${{ 'not-installed': '未導入', installed: '導入済み（最新）', outdated: '導入済み（パスや内容が古い）' }[r.status]}`);
  if (r.changes.length) {
    L.push(r.action === 'check' ? '--apply で行う変更:' : '変更:');
    r.changes.forEach((c) => L.push(`  + ${c}`));
  }
  if (r.config) L.push(`config: ${r.config}`);
  if (r.rules) L.push(`Rules: ${r.rules}`);
  r.notes.forEach((n) => L.push(`注: ${n}`));
  r.wrote.forEach((w) => L.push(`✔ ${w}`));
  return L.join('\n');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    const { code, report } = run(opts);
    process.stdout.write((opts.json ? JSON.stringify(report, null, 2) : printReport(report)) + '\n');
    process.exitCode = code;
  } catch (e) {
    process.stderr.write(`エラー: ${e.message}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = { buildOwnGroups, removeOwn, addOwn, run, parseArgs, VL };
