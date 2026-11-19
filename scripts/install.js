#!/usr/bin/env node
'use strict';
// settings.json merger for environments where the plugin cannot be used.
//   node scripts/install.js [--check] [--scope user|project] [--json]     read-only (default)
//   node scripts/install.js --apply     [--mode observe|off] [--rules]
//   node scripts/install.js --uninstall [--rules] [--purge]
//   node scripts/install.js --agent codex [--check|--apply|--uninstall] [--agents-md] [--repo-skill]
//     (Codex CLI: $CODEX_HOME/hooks.json; see scripts/lib/install-codex.js)
// Other options: --settings-file PATH, --project-dir DIR, --node PATH, --force
// Own hooks are recognised by the vl.js path in their args (see lib/settings.js);
// foreign hooks are never edited, removed or reordered.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { claudeDir, configDir, configPath } = require('./lib/config');
const { repoRoot, git, scrubbedEnv } = require('./lib/git');
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

// Returns { settings, removed } without mutating the input. `isOwn` recognises our handlers
// (Claude exec form by default; the Codex installer passes its own predicate). The predicate also
// sees the event and group the handler sits in: ownership is by position as well as by shape.
function removeOwn(settings, isOwn = isOwnHandler) {
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
      const handlers = g.hooks.filter((h) => !isOwn(h, event, g));
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

// A `hooks` value (or an event value we would add to) that is not the documented shape. Writing
// would replace it and silently drop whatever it holds, so the installers refuse instead.
function hooksShapeError(settings, ownGroups) {
  if (!settings || !('hooks' in settings)) return null;
  const h = settings.hooks;
  if (h === null || typeof h !== 'object' || Array.isArray(h)) return '"hooks" がオブジェクトではありません';
  for (const { event } of ownGroups) {
    if (event in h && !Array.isArray(h[event])) return `"hooks.${event}" が配列ではありません`;
  }
  return null;
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

// Writes through symlinks (dotfile managers) and keeps the original file mode. A dangling symlink
// is refused rather than replaced by a regular file.
function atomicWrite(file, text) {
  let target = file;
  let mode;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    let link = false;
    try {
      link = fs.lstatSync(file).isSymbolicLink();
    } catch {
      /* new file */
    }
    if (link) throw new Error(`${file} はリンク先のないシンボリックリンクです。何も書いていません`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.vl-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

// A file that lives inside a git work tree (project-scope settings.local.json) must not get a
// sibling backup: `git add -A` would pick it up together with whatever secrets the file holds.
function insideWorkTree(file) {
  let p = path.dirname(path.resolve(file));
  while (!fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
  return git(['rev-parse', '--is-inside-work-tree'], { cwd: p, fullEnv: scrubbedEnv() }).out.trim() === 'true';
}

// Backups sit beside the file, except inside a work tree: then they go to the user-private
// <config>/backups directory. Never overwrites an earlier backup, even within the same second.
function backup(file) {
  if (!fs.existsSync(file)) return null;
  let dir = path.dirname(file);
  let name = path.basename(file);
  if (insideWorkTree(file)) {
    dir = path.join(configDir(), 'backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    name = `${crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 8)}-${name}`;
  }
  const base = path.join(dir, `${name}.verify-layer-backup-${timestamp()}`);
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

// Replacing a file takes more than write access to it: the atomic write and the backup create new
// files next to it (or next to the real file behind a symlink). Checked for every target before the
// first write, so a refusal leaves nothing half-installed.
function isWritable(file) {
  const ok = (p) => {
    try {
      fs.accessSync(p, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  let real = null;
  try {
    real = fs.realpathSync(file);
  } catch {
    /* new file (or dangling link): judged by its nearest existing ancestor */
  }
  if (real) return ok(real) && ok(path.dirname(real));
  let p = file;
  while (!fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
  return ok(p);
}

function resolveTargets(opts) {
  const scope = opts.scope || 'user';
  if (!['user', 'project'].includes(scope)) throw new Error(`--scope は user か project です: ${scope}`);
  const projectDir = path.resolve(opts.projectDir || repoRoot(process.cwd(), { fullEnv: scrubbedEnv() }) || process.cwd());
  // The hook path is machine-specific, so project scope uses the git-ignored local file.
  const settingsFile = opts.settingsFile
    ? path.resolve(opts.settingsFile)
    : scope === 'user'
      ? path.join(claudeDir(), 'settings.json')
      : path.join(projectDir, '.claude', 'settings.local.json');
  const rulesFile = scope === 'user' ? path.join(claudeDir(), 'rules', 'verification.md') : path.join(projectDir, '.claude', 'rules', 'verification.md');
  return { scope, settingsFile, rulesFile };
}

// settings.local.json holds this machine's absolute paths (and often local permissions or
// credentials): it may only be written where git will not offer it for commit.
function localFileProblem(file) {
  const cwd = path.dirname(path.resolve(file));
  let dir = cwd;
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const g = (args) => git(args, { cwd: dir, fullEnv: scrubbedEnv() });
  if (g(['rev-parse', '--is-inside-work-tree']).out.trim() !== 'true') return null;
  const hint = '.gitignore か .git/info/exclude に `.claude/settings.local.json` を足してから再実行してください';
  if (g(['ls-files', '--error-unmatch', '--', file]).ok) return `${file} は git で追跡されています（コミットに入ります）。追跡から外すか、--scope user を使ってください`;
  if (!g(['check-ignore', '-q', '--', file]).ok) return `${file} は git の除外（ignore）に入っていません。このファイルはこの端末の絶対パスを含み、コミット候補になります。${hint}`;
  return null;
}

function managedBlocks() {
  const m = readJsonFile(managedSettingsPath());
  return !!(m.data && m.data.allowManagedHooksOnly === true);
}

// --- main ----------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { action: 'check' };
  // Every option that takes a value must have one: a missing value must not silently fall back to
  // another scope or file (`--uninstall --scope` once meant "user").
  const val = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith('--') && v.length > 2)) throw new Error(`${flag} には値が必要です`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.action = 'check';
    else if (a === '--apply') o.action = 'apply';
    else if (a === '--uninstall') o.action = 'uninstall';
    else if (a === '--scope') o.scope = val(a, i++);
    else if (a === '--settings-file') o.settingsFile = val(a, i++);
    else if (a === '--project-dir') o.projectDir = val(a, i++);
    else if (a === '--mode') o.mode = val(a, i++);
    else if (a === '--node') o.node = val(a, i++);
    else if (a === '--rules') o.rules = true;
    else if (a === '--purge') o.purge = true;
    else if (a === '--force') o.force = true;
    else if (a === '--json') o.json = true;
    else if (a === '--agent') o.agent = val(a, i++);
    else if (a === '--hooks-file') o.hooksFile = val(a, i++);
    else if (a === '--agents-md') o.agentsMd = true;
    else if (a === '--repo-skill') o.repoSkill = true;
    else throw new Error(`不明なオプション: ${a}`);
  }
  if (o.mode !== undefined && !['observe', 'off'].includes(o.mode)) throw new Error('--mode は observe か off です（enforce は v0.1 にありません）');
  if (o.agent !== undefined && !['claude', 'codex'].includes(o.agent)) throw new Error(`--agent は claude か codex です: ${o.agent}`);
  const codexOnly = ['hooksFile', 'agentsMd', 'repoSkill'].filter((k) => o[k] !== undefined);
  if (o.agent !== 'codex' && codexOnly.length) throw new Error('--hooks-file / --agents-md / --repo-skill は --agent codex と一緒に使います');
  if (o.agent === 'codex' && (o.rules || o.settingsFile)) throw new Error('--rules / --settings-file は Claude 用です（Codex は --agents-md / --hooks-file）');
  return o;
}

function run(opts) {
  if (opts.agent === 'codex') return require('./lib/install-codex').run(opts);
  const t = resolveTargets(opts);
  const report = { action: opts.action, scope: t.scope, settingsFile: t.settingsFile, changes: [], notes: [], wrote: [] };
  const read = readJsonFile(t.settingsFile);
  if (read.error) {
    report.error = `${t.settingsFile} を読めません（${read.error}）。何も書いていません。JSON として直してから再実行してください`;
    return { code: 2, report };
  }
  if (t.scope === 'project') {
    const problem = localFileProblem(t.settingsFile);
    if (problem && opts.action === 'apply') {
      report.error = `${problem}。何も書いていません`;
      return { code: 2, report };
    }
    if (problem) report.notes.push(problem);
  }
  const before = read.data || {};
  const nodeCmd = opts.node || 'node';
  const ownGroups = buildOwnGroups(nodeCmd);
  const shape = hooksShapeError(before, ownGroups);
  if (shape) {
    report.error = `${t.settingsFile} の ${shape}。書き換えると中身が失われるため、何も書いていません。直してから再実行してください`;
    return { code: 2, report };
  }
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
  L.push(`verify-layer install — ${label} / ${r.agent === 'codex' ? 'Codex' : `scope=${r.scope}`}`);
  L.push(`対象: ${r.settingsFile}`);
  if (r.error) L.push(`エラー: ${r.error}`);
  if (r.status) L.push(`状態: ${{ 'not-installed': '未導入', installed: '導入済み（最新）', outdated: '導入済み（パスや内容が古い）', 'codex-not-found': 'Codex が見つかりません（Codex の部分は飛ばします）' }[r.status]}`);
  (r.targets || []).forEach((x) => L.push(`  ${x}`));
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

module.exports = { buildOwnGroups, removeOwn, addOwn, hooksShapeError, run, parseArgs, VL, atomicWrite, backup, isWritable, indentOf, printReport };

if (require.main === module) main();
