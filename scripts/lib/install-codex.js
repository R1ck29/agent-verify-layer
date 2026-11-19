'use strict';
// `install.js --agent codex`: merges this tool's one hook into $CODEX_HOME/hooks.json and, on
// request, appends the two AGENTS.md lines (--agents-md). `--repo-skill` is a separate operation
// that only copies (or removes) the repo verify skill and leaves hooks.json / AGENTS.md alone. Read-only unless --apply / --uninstall. Foreign hooks and lines are never
// edited, removed or reordered; a second --apply changes nothing.
const fs = require('node:fs');
const path = require('node:path');
const { readJsonFile } = require('./settings');
const { repoRoot } = require('./git');
const { configPath } = require('./config');
const codex = require('./codex');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILL_SRC = path.join(ROOT, 'codex', 'skills', 'verify');

function codexFound(home) {
  return fs.existsSync(home) || codex.codexVersion() !== null;
}

function countHandlers(hooksDoc) {
  let n = 0;
  for (const groups of Object.values((hooksDoc && hooksDoc.hooks) || {})) for (const g of Array.isArray(groups) ? groups : []) n += Array.isArray(g && g.hooks) ? g.hooks.length : 0;
  return n;
}

// --- AGENTS.md -------------------------------------------------------------------------------

function splitLines(text) {
  return text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
}

// Returns { text, changed } for the wanted state: our two lines present (apply) or absent (uninstall).
// Lines the user moved elsewhere in the file are left where they are when already up to date.
function nextAgentsText(current, lines, action) {
  const eol = /\r\n/.test(current) ? '\r\n' : '\n';
  const all = splitLines(current);
  const ours = all.filter((l) => codex.AGENTS_LINE_RE.test(l));
  if (action !== 'uninstall' && ours.length === lines.length && lines.every((l) => ours.includes(l))) return { text: current, changed: false };
  const kept = all.filter((l) => !codex.AGENTS_LINE_RE.test(l));
  const next = action === 'uninstall' ? kept : [...kept, ...lines];
  const text = next.length ? next.join(eol) + eol : '';
  return { text, changed: text !== current };
}

// Plans the AGENTS.md change (everything that can fail fails here, before any file is written) and
// returns the function that performs it, or null when there is nothing to write.
function handleAgentsMd(opts, report, t, home) {
  const file = codex.agentsFile(home);
  const exists = fs.existsSync(file);
  const current = exists ? fs.readFileSync(file, 'utf8') : '';
  const lines = codex.agentsLines(opts.node || 'node');
  const { text, changed } = nextAgentsText(current, lines, opts.action === 'uninstall' ? 'uninstall' : 'apply');
  report.targets.push(`AGENTS.md: ${file}${changed ? '' : '（変更なし）'}`);
  if (opts.action === 'check') {
    if (changed) lines.forEach((l) => report.changes.push(`AGENTS.md に追記: ${l}`));
    return null;
  }
  if (!changed) return null;
  if (!t.isWritable(file)) throw new Error(`${file} に書き込めません。何も書いていません`);
  return () => {
    const b = t.backup(file);
    if (b) report.wrote.push(`バックアップ: ${b}`);
    t.atomicWrite(file, text);
    report.wrote.push(`${opts.action === 'uninstall' ? '2 行を外しました' : '2 行を追記しました'}: ${file}`);
  };
}

// --- repo verify skill -----------------------------------------------------------------------

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p));
  }
  return out.sort();
}

const lexists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// The approval covers this repository only: every existing parent of the skill directory, and
// every existing file in it, must resolve (through symlinks) to a place inside the repository.
function assertInsideRepo(project, dest, files) {
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const root = fold(fs.realpathSync(project));
  const inside = (p) => {
    const r = fold(fs.realpathSync(p)); // a dangling link throws: refused as well
    return r === root || r.startsWith(root + path.sep);
  };
  const outside = (p) => new Error(`${p} はリポジトリの外に解決されます（シンボリックリンク）。リポジトリ単位の承認の範囲外なので、何もしません`);
  let p = dest;
  while (!lexists(p) && path.dirname(p) !== p) p = path.dirname(p);
  let ok;
  try {
    ok = inside(p);
  } catch {
    ok = false;
  }
  if (!ok) throw outside(p);
  for (const f of files) {
    const file = path.join(dest, f);
    if (!lexists(file)) continue;
    let fileOk;
    try {
      fileOk = inside(file);
    } catch {
      fileOk = false;
    }
    if (!fileOk) throw outside(file);
  }
}

function handleRepoSkill(opts, report) {
  const dir = path.resolve(opts.projectDir || process.cwd());
  const project = repoRoot(dir);
  if (!project) {
    throw new Error(opts.projectDir ? `指定した ${dir} は Git リポジトリ内ではありません（--repo-skill はリポジトリ単位です）` : `${dir} は Git リポジトリ内ではありません。--repo-skill はリポジトリの中で実行するか、--project-dir で指定してください`);
  }
  const dest = path.join(project, '.agents', 'skills', 'verify');
  const files = listFiles(SKILL_SRC);
  assertInsideRepo(project, dest, files);
  const same = files.every((f) => {
    try {
      return fs.readFileSync(path.join(dest, f), 'utf8') === fs.readFileSync(path.join(SKILL_SRC, f), 'utf8');
    } catch {
      return false;
    }
  });
  const exists = fs.existsSync(path.join(dest, 'SKILL.md'));
  report.targets.push(`verify スキル: ${dest}${same ? '（雛形と同じ）' : exists ? '（別の内容であり。上書きしません）' : ''}`);
  if (opts.action === 'uninstall') {
    if (!exists) return;
    if (!same) {
      report.notes.push(`${dest} は雛形から変更されているため残しました`);
      return;
    }
    for (const f of files) fs.unlinkSync(path.join(dest, f));
    for (let d = dest; d !== project && fs.existsSync(d) && fs.readdirSync(d).length === 0; d = path.dirname(d)) fs.rmdirSync(d);
    report.wrote.push(`削除: ${dest}`);
    return;
  }
  if (same) return;
  if (exists) {
    report.notes.push(`${dest} は既にあるため上書きしません（雛形は ${SKILL_SRC}）`);
    return;
  }
  if (opts.action === 'check') {
    report.changes.push(`verify スキルを置く: ${dest}`);
    return;
  }
  for (const f of files) {
    const to = path.join(dest, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(SKILL_SRC, f), to, fs.constants.COPYFILE_EXCL);
  }
  report.wrote.push(`verify スキル: ${dest}（コミットするかは利用者が決めます）`);
}

// --- main ------------------------------------------------------------------------------------

function run(opts) {
  const t = require('../install'); // shared file helpers (lazy: install.js requires this module)
  const home = codex.codexHome();
  const hooksFile = opts.hooksFile ? path.resolve(opts.hooksFile) : path.join(home, 'hooks.json');
  const report = { action: opts.action, agent: 'codex', scope: 'user', settingsFile: hooksFile, changes: [], notes: [], wrote: [], targets: [] };
  if (opts.scope && opts.scope !== 'user') {
    report.error = 'Codex は --scope user だけです（.codex/hooks.json は信頼済みのプロジェクトでしか読まれず、端末ごとの絶対パスをコミットすることになるため）';
    return { code: 2, report };
  }
  if (!opts.hooksFile && !codexFound(home)) {
    report.status = 'codex-not-found';
    report.notes.push(`${home} も codex コマンドも見つかりません。Claude の部分だけを入れてください`);
    return { code: opts.action === 'check' ? 0 : 3, report };
  }

  // The repo skill is its own unit (per repository, its own approval): it never touches hooks.json.
  if (opts.repoSkill) {
    if (opts.agentsMd || opts.mode) {
      report.error = '--repo-skill はリポジトリのスキルだけを扱います。--agents-md / --mode とは別に実行してください';
      return { code: 2, report };
    }
    report.settingsFile = 'リポジトリの .agents/skills/verify（hooks.json と AGENTS.md は変更しません）';
    try {
      handleRepoSkill(opts, report);
    } catch (e) {
      report.error = e.message;
      return { code: 2, report };
    }
    return { code: 0, report };
  }

  const read = readJsonFile(hooksFile);
  if (read.error) {
    report.error = `${hooksFile} を読めません（${read.error}）。何も書いていません。JSON として直してから再実行してください`;
    return { code: 2, report };
  }
  const before = read.data || {};
  let own;
  try {
    own = codex.ownGroups(opts.node || 'node');
  } catch (e) {
    report.error = `${e.message}。何も書いていません（--node か vl.js のパスを、シェルで 1 語として書ける場所にしてください）`;
    return { code: 2, report };
  }
  const shape = t.hooksShapeError(before, own);
  if (shape) {
    report.error = `${hooksFile} の ${shape}。書き換えると中身が失われるため、何も書いていません。直してから再実行してください`;
    return { code: 2, report };
  }
  const { settings: stripped, removed } = t.removeOwn(before, codex.isOwnCodexHandler);
  const after = opts.action === 'uninstall' ? stripped : t.addOwn(stripped, own);
  const same = JSON.stringify(after) === JSON.stringify(before);
  report.installedHandlers = removed;
  report.foreignHandlers = countHandlers(stripped);
  report.upToDate = same;
  report.notes.push(`既存の hook ${report.foreignHandlers} 件は変更しません`);

  const blockers = codex.hookBlockers(home);
  if (blockers.hooksOff.length) report.notes.push(`hooks が無効です（${blockers.hooksOff.join(', ')} の [features] hooks = false）。入れても動きません`);
  if (blockers.managedOnly.length && opts.action === 'apply' && !opts.force) {
    report.error = `${blockers.managedOnly.join(', ')} に allow_managed_hooks_only = true があり、利用者の hook は動きません。書き込みを中止しました（--force で無視）。管理者に requirements.toml の [hooks] で配ってもらってください`;
    return { code: 3, report };
  }
  if (blockers.managedOnly.length) report.notes.push(`allow_managed_hooks_only = true（${blockers.managedOnly.join(', ')}）: 利用者の hook は動きません`);

  if (opts.action === 'check') {
    report.status = removed === 0 ? 'not-installed' : same ? 'installed' : 'outdated';
    if (!same) own.forEach(({ event, group }) => group.hooks.forEach((h) => report.changes.push(`${event} [${group.matcher}] → ${h.command}`)));
  } else if (opts.action === 'apply') {
    own.forEach(({ event, group }) => group.hooks.forEach((h) => report.changes.push(`${event} [${group.matcher}] → ${h.command}`)));
  } else if (removed) {
    report.changes.push(`自分の hook ${removed} 件を外す`);
  }

  let writeAgents = null;
  try {
    if (opts.agentsMd) writeAgents = handleAgentsMd(opts, report, t, home);
  } catch (e) {
    report.error = e.message;
    return { code: 2, report };
  }
  if (opts.action === 'check') return { code: 0, report };

  // Every target is checked before the first write, so a failure leaves nothing half-installed.
  if (!same && !t.isWritable(hooksFile)) {
    report.error = `${hooksFile} に書き込めません（読み取り専用）。何も書いていません`;
    return { code: 2, report };
  }
  if (writeAgents) writeAgents();
  if (!same) {
    const b = t.backup(hooksFile);
    if (b) report.wrote.push(`バックアップ: ${b}`);
    if (opts.action === 'uninstall' && Object.keys(after).length === 0 && !fs.lstatSync(hooksFile).isSymbolicLink()) {
      fs.unlinkSync(fs.realpathSync(hooksFile));
      report.wrote.push(`削除: ${hooksFile}（空になったため。バックアップあり）`);
    } else {
      t.atomicWrite(hooksFile, JSON.stringify(after, null, t.indentOf(read.text)) + '\n');
      report.wrote.push(`更新: ${hooksFile}`);
    }
  } else {
    report.notes.push('hooks.json は既に目的の状態です（書き込みなし）');
  }
  if (opts.action === 'apply') {
    if (opts.mode) {
      const cfg = readJsonFile(configPath());
      const data = { ...(cfg.data || {}), mode: opts.mode };
      t.atomicWrite(configPath(), JSON.stringify(data, null, 2) + '\n');
      report.wrote.push(`設定: ${configPath()}（mode=${opts.mode}。Claude と共通）`);
    }
    report.notes.push('Codex を起動して /hooks を開き、verify-layer の hook（PostToolUse ^Bash$）を確認して信頼してください。信頼するまで実行されません。hook の定義が変わると（--apply で入れ直したときを含む）再び確認が要ります');
  } else {
    report.notes.push('各リポジトリの台帳（.git/claude-verify/）は残しています。消すかどうかは利用者が決めてください');
  }
  return { code: 0, report };
}

module.exports = { run, nextAgentsText, SKILL_SRC };
