#!/usr/bin/env node
'use strict';
// settings.json merger for environments where the plugin cannot be used.
//   node scripts/install.js [--check] [--scope user|project] [--json]     read-only (default)
//   node scripts/install.js --apply     [--mode observe|off] [--rules]
//   node scripts/install.js --uninstall [--rules] [--purge]
//   node scripts/install.js --agent codex [--check|--apply|--uninstall] [--agents-md] [--repo-skill]
//     (Codex CLI: $CODEX_HOME/hooks.json; see scripts/lib/install-codex.js)
//   node scripts/install.js --v02 [--agent claude|codex] [--check|--apply|--uninstall] [--repo-skill]
// Other options: --settings-file PATH, --project-dir DIR, --node PATH, --force
// Own hooks are recognised by the current or previously installed absolute vl.js path;
// foreign hooks are never edited, removed or reordered.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { claudeDir, configDir, configPath } = require('./lib/config');
const { repoRoot, git, scrubbedEnv } = require('./lib/git');
const { isOwnHandler, readJsonFile, managedSettingsPath } = require('./lib/settings');
const { v02Groups, v02Script } = require('./lib/hooks-v02');

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
function removeOwn(settings, isOwn) {
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

// Resolve existing files and ancestors of new files before checking or changing them.
function writeTarget(file) {
  const abs = path.resolve(file);
  try {
    return fs.realpathSync(abs);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    fs.lstatSync(abs);
  } catch (e) {
    const parent = path.dirname(abs);
    if (e.code !== 'ENOENT' || parent === abs) throw e;
    return path.join(writeTarget(parent), path.basename(abs));
  }
  throw new Error(`${file} はリンク先のないシンボリックリンクです。何も書いていません`);
}

// The caller can pass the same resolved target it validated before any writes.
function atomicWrite(file, text, target = writeTarget(file)) {
  const st = fs.lstatSync(target, { throwIfNoEntry: false });
  const mode = st && (st.mode & 0o777);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.vl-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, st ? { mode } : undefined);
  if (st) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

// A path can belong to more than one worktree. Check outward even when the closest Git
// context is bare, and treat discovery errors other than "not a git repository" as unsafe.
function* containingWorkTrees(directory) {
  let cwd = path.resolve(directory);
  while (!fs.existsSync(cwd) && path.dirname(cwd) !== cwd) cwd = path.dirname(cwd);
  const fullEnv = scrubbedEnv();
  const env = { LC_ALL: 'C', GIT_DISCOVERY_ACROSS_FILESYSTEM: '1' };
  const discoveryError = () => new Error(`${directory} が Git 作業ツリーの内側か確認できません。何も書いていません`);
  for (;;) {
    const r = git(['rev-parse', '--is-inside-work-tree'], { cwd, fullEnv, env });
    if (r.status === 128 && /^fatal: not a git repository\b/m.test(r.err)) return;
    if (!r.ok) throw discoveryError();
    let boundary = cwd;
    if (r.out.trim() === 'true') {
      const root = repoRoot(cwd, { fullEnv, env });
      if (!root) throw discoveryError();
      const rel = path.relative(root, cwd);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw discoveryError();
      yield root;
      boundary = root;
    } else if (r.out.trim() !== 'false') {
      throw discoveryError();
    }
    const parent = path.dirname(boundary);
    if (parent === boundary) return;
    cwd = parent;
  }
}

function insideWorkTree(dir) {
  return !containingWorkTrees(dir).next().done;
}

function assertOutsideWorkTree(dir) {
  if (insideWorkTree(dir)) throw new Error(`${dir} は Git 作業ツリーの内側です。作業ツリー外の保存先を指定してください。何も書いていません`);
}

function privateWriteTarget(file) {
  const target = writeTarget(file);
  assertOutsideWorkTree(path.dirname(target));
  return target;
}

// A different checkout can replace a path we installed for this settings file and agent.
// Without registration evidence only this checkout's absolute path is eligible.
function hookRegistration(agent, settingsTarget) {
  const key = crypto.createHash('sha256').update(settingsTarget).digest('hex');
  const file = path.join(configDir(), `hooks-${agent}-${key}.json`);
  const recorded = readJsonFile(file).data?.script;
  const previous = typeof recorded === 'string' && path.isAbsolute(recorded) &&
    !insideWorkTree(path.dirname(writeTarget(file))) ? recorded : null;
  return { file, previous, paths: new Set(previous ? [VL, previous] : [VL]) };
}

function planRegistration(registration, action, changed) {
  const { file, previous } = registration;
  if (action === 'uninstall') return previous ? () => fs.rmSync(file, { force: true }) : null;
  if (!changed || previous === VL) return null;
  const target = privateWriteTarget(file);
  if (!isWritable(target)) throw new Error(`${target} に書き込めません。何も書いていません`);
  return () => atomicWrite(file, JSON.stringify({ script: VL }) + '\n', target);
}

// Validate the real backup destination before any writes. A work-tree settings file must never
// get a sibling backup, whether the caller used the actual path or a symlink.
function planBackup(file, target = writeTarget(file)) {
  if (!fs.existsSync(target)) return () => null;
  let dir = path.dirname(file);
  let name = path.basename(file);
  const local = insideWorkTree(dir) || insideWorkTree(path.dirname(target));
  if (local) {
    dir = path.join(configDir(), 'backups');
    name = `${crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 8)}-${name}`;
  }
  dir = writeTarget(dir);
  assertOutsideWorkTree(dir);
  return () => {
    if (local) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = path.join(dir, `${name}.verify-layer-backup-${timestamp()}`);
    for (let n = 0; n < 1000; n++) {
      const dest = n === 0 ? base : `${base}-${n}`;
      try {
        fs.copyFileSync(target, dest, fs.constants.COPYFILE_EXCL);
        return dest;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw new Error('バックアップの名前を決められません');
  };
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
function localFileProblem(file, target) {
  const hint = '.gitignore か .git/info/exclude に `.claude/settings.local.json` を足してから再実行してください';
  const fullEnv = scrubbedEnv();
  for (const p of new Set([file, target])) {
    for (const cwd of containingWorkTrees(path.dirname(p))) {
      const g = (args) => git(args, { cwd, fullEnv });
      const tracked = g(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', p]);
      if (tracked.ok) return `${p} は git で追跡されています（コミットに入ります）。追跡から外すか、--scope user を使ってください`;
      if (tracked.status !== 1) return `${p} の Git 追跡状態を確認できません`;
      if (!g(['check-ignore', '-q', '--', p]).ok) return `${p} は git の除外（ignore）に入っていません。このファイルはこの端末の絶対パスを含み、コミット候補になります。${hint}`;
    }
  }
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
    else if (a === '--v02') o.v02 = true;
    else throw new Error(`不明なオプション: ${a}`);
  }
  if (o.mode !== undefined && !['observe', 'off'].includes(o.mode)) throw new Error('--mode は observe か off です（enforce は v0.1 にありません）');
  if (o.agent !== undefined && !['claude', 'codex'].includes(o.agent)) throw new Error(`--agent は claude か codex です: ${o.agent}`);
  if (o.v02 && (o.mode || o.rules || o.purge || o.agentsMd)) {
    throw new Error('--v02 のモードはリポジトリの .verify-layer.json で設定します。--mode / --rules / --purge / --agents-md は v0.1 用です');
  }
  const codexOnly = ['hooksFile', 'agentsMd', ...(!o.v02 ? ['repoSkill'] : [])].filter((k) => o[k] !== undefined);
  if (o.agent !== 'codex' && codexOnly.length) throw new Error('--hooks-file / --agents-md / --repo-skill は --agent codex と一緒に使います');
  if (o.agent === 'codex' && (o.rules || o.settingsFile)) throw new Error('--rules / --settings-file は Claude 用です（Codex は --agents-md / --hooks-file）');
  return o;
}

function run(opts) {
  if (opts.v02 && opts.repoSkill) return require('./lib/install-codex').runV02Skill(opts);
  if (opts.agent === 'codex') return require('./lib/install-codex').run(opts);
  const t = resolveTargets(opts);
  const report = { action: opts.action, scope: t.scope, settingsFile: t.settingsFile, changes: [], notes: [], wrote: [] };
  const read = readJsonFile(t.settingsFile);
  if (read.error) {
    report.error = `${t.settingsFile} を読めません（${read.error}）。何も書いていません。JSON として直してから再実行してください`;
    return { code: 2, report };
  }
  const target = writeTarget(t.settingsFile);
  const problem = t.scope === 'project' ? localFileProblem(t.settingsFile, target) : null;
  if (problem && opts.action === 'apply') {
    report.error = `${problem}。何も書いていません`;
    return { code: 2, report };
  }
  if (problem) report.notes.push(problem);
  const before = read.data || {};
  const nodeCmd = opts.node || 'node';
  const ownGroups = opts.v02 ? v02Groups('claude', nodeCmd) : buildOwnGroups(nodeCmd);
  const shape = hooksShapeError(before, ownGroups);
  if (shape) {
    report.error = `${t.settingsFile} の ${shape}。書き換えると中身が失われるため、何も書いていません。直してから再実行してください`;
    return { code: 2, report };
  }
  const registration = hookRegistration(opts.v02 ? 'claude-v02' : 'claude', target);
  const { settings: stripped, removed } = removeOwn(before, (h, event, group) => opts.v02
    ? v02Script('claude', h, event, group, registration.paths)
    : isOwnHandler(h, event, group, registration.paths));
  report.installedHandlers = removed;
  report.foreignHandlers = (() => {
    let n = 0;
    for (const groups of Object.values(stripped.hooks || {})) for (const g of groups || []) n += Array.isArray(g && g.hooks) ? g.hooks.length : 0;
    return n;
  })();

  const after = opts.action === 'uninstall' ? stripped : addOwn(stripped, ownGroups);
  const same = JSON.stringify(after) === JSON.stringify(before);
  if (problem && opts.action === 'uninstall' && !same) {
    report.error = `${problem}。何も書いていません`;
    return { code: 2, report };
  }
  report.upToDate = same;
  if (opts.action === 'check') {
    report.status = removed === 0 ? 'not-installed' : same ? 'installed' : 'outdated';
    if (!same) report.changes = describeGroups(ownGroups);
    report.notes.push(`既存の hook ${report.foreignHandlers} 件は変更しません`);
    if (managedBlocks()) report.notes.push('管理設定の allowManagedHooksOnly が有効です。--apply しても hook は動きません（管理者向けの配布が必要）');
    if (opts.v02) {
      report.notes.push('v0.2 のモードは各リポジトリの .verify-layer.json にある verifyV2 で設定します');
    } else {
      const cfg = readJsonFile(configPath());
      report.config = cfg.exists ? (cfg.data ? `mode=${cfg.data.mode}` : '読めません') : '未作成（--apply で {"mode":"observe"} を作成）';
      report.rules = fs.existsSync(t.rulesFile) ? `あり: ${t.rulesFile}` : `なし（--rules で ${t.rulesFile} に置く）`;
    }
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

  const cfg = opts.action === 'apply' && !opts.v02 ? readJsonFile(configPath()) : null;
  const configTarget = cfg && (!cfg.exists || opts.mode) ? privateWriteTarget(configPath()) : null;
  const writeRegistration = planRegistration(registration, opts.action, !same);
  if (!same) {
    if (!isWritable(t.settingsFile)) {
      report.error = `${t.settingsFile} に書き込めません（読み取り専用）。何も書いていません`;
      return { code: 2, report };
    }
    const b = planBackup(t.settingsFile, target)();
    if (b) report.wrote.push(`バックアップ: ${b}`);
    if (opts.action === 'uninstall' && Object.keys(after).length === 0 && !fs.lstatSync(t.settingsFile).isSymbolicLink()) {
      fs.unlinkSync(target); // we emptied it: nothing else lived there
      report.wrote.push(`削除: ${t.settingsFile}（空になったため。バックアップあり）`);
    } else {
      atomicWrite(t.settingsFile, JSON.stringify(after, null, indentOf(read.text)) + '\n', target);
      report.wrote.push(`更新: ${t.settingsFile}`);
    }
  } else {
    report.notes.push('settings は既に目的の状態です（書き込みなし）');
  }
  if (writeRegistration) writeRegistration();

  if (opts.action === 'apply') {
    if (configTarget) {
      const data = { ...(cfg.data || {}) };
      data.mode = opts.mode || data.mode || 'observe';
      atomicWrite(configPath(), JSON.stringify(data, null, 2) + '\n', configTarget);
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

module.exports = { buildOwnGroups, removeOwn, addOwn, hooksShapeError, run, parseArgs, VL, atomicWrite, writeTarget, privateWriteTarget, planBackup, hookRegistration, planRegistration, isWritable, indentOf, printReport };

if (require.main === module) main();
