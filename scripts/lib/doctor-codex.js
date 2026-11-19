'use strict';
// `vl.js doctor`, Codex part (sources/codex/hooks.md, skills.md, guides_agents-md.md).
// Read-only. When neither $CODEX_HOME nor the codex command exists, one info line and nothing else:
// a Claude-only machine never gets a warning from here.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codex = require('./codex');
const { readJsonFile, allHandlers } = require('./settings');

const DOCUMENTED_VERSION = [0, 170, 0]; // the docs copied under sources/codex/ are for 0.170
const AGENTS_MAX_BYTES = 32 * 1024; // project_doc_max_bytes default
const TEMPLATE = path.resolve(__dirname, '..', '..', 'codex', 'skills', 'verify', 'SKILL.md');

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text || '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function older(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

// Own handlers in one hooks.json: { exists, error?, own: [{ script }] }.
function ownInHooksFile(file) {
  const r = readJsonFile(file);
  if (!r.exists) return { exists: false, own: [] };
  if (r.error) return { exists: true, error: r.error, own: [] };
  const own = allHandlers(r.data)
    .filter(({ handler }) => codex.isOwnCodexHandler(handler))
    .map(({ handler }) => ({ script: codex.ownScriptPath(handler) }));
  return { exists: true, own };
}

function checkVersion(add, env) {
  const v = codex.codexVersion(env);
  if (v === null) {
    add('info', 'Codex: codex コマンドが見つかりません（版は確認できません）');
    return;
  }
  const pv = parseVersion(v);
  if (pv && older(pv, DOCUMENTED_VERSION)) add('warn', `Codex: codex ${v}: 0.170 より前の版は、hooks の動きが文書と合っているか確かめていません`);
  else add('info', `Codex: codex ${v}`);
}

// Where our hook is registered (each place runs it once, concurrently).
function ownLocations(add, home, root) {
  const where = [];
  const userFile = path.join(home, 'hooks.json');
  const user = ownInHooksFile(userFile);
  if (user.error) add('warn', `Codex: ${userFile} を読めません: ${user.error}`);
  for (const o of user.own) {
    where.push(userFile);
    if (o.script && !fs.existsSync(o.script)) add('ng', `Codex: 登録された vl.js が存在しません: ${o.script}`);
  }
  if (root) {
    const projFile = path.join(root, '.codex', 'hooks.json');
    where.push(...ownInHooksFile(projFile).own.map(() => projFile));
  }
  const cfgFile = path.join(home, 'config.toml');
  const cfg = codex.readText(cfgFile);
  if (cfg && /vl\.js[^\n]*hook\s+commit/.test(cfg)) where.push(cfgFile);
  return where;
}

function checkHooks(add, home, root, env) {
  const where = ownLocations(add, home, root);
  const blockers = codex.hookBlockers(home, env);
  const level = where.length ? 'ng' : 'warn';
  if (blockers.hooksOff.length) add(level, `Codex: hooks が無効です（${blockers.hooksOff.join(', ')} の [features] hooks = false）`);
  else add('info', 'Codex: features.hooks は無効にされていません（既定で有効）');
  if (blockers.managedOnly.length) add(level, `Codex: allow_managed_hooks_only = true（${blockers.managedOnly.join(', ')}）。利用者の hook は動きません。管理者に requirements.toml の [hooks] で配ってもらってください`);

  if (!where.length) {
    add('info', 'Codex: verify-layer の hook は未導入です（node scripts/install.js --agent codex --apply）');
    return;
  }
  if (where.length > 1) add('warn', `Codex: verify-layer の hook が ${where.length} か所にあります（${where.join(', ')}）。全部が同時に走るので 1 か所にしてください`);
  else add('ok', `Codex: verify-layer の hook があります（${where[0]}）`);
  add('info', 'Codex: hook は信頼するまで動きません。Codex で /hooks を開き、verify-layer の hook（PostToolUse ^Bash$）が信頼済みか確かめてください（doctor は信頼の状態を読めません）');
}

function checkProjectTrust(add, home, root) {
  if (!root) return;
  const trust = codex.projectTrust(codex.readText(path.join(home, 'config.toml')), root) || '未登録';
  add('info', `Codex: このリポジトリの信頼 = ${trust}（利用者の hooks.json の hook は信頼に関係なく動きます。.codex/ の設定は trusted のときだけ読まれます）`);
}

function checkSkill(add, root) {
  const personal = path.join(os.homedir(), '.agents', 'skills', 'verify', 'SKILL.md');
  if (fs.existsSync(personal)) add('warn', `Codex: 個人用の verify スキルがあります（${personal}）。リポジトリの verify と両方が一覧に出ます`);
  if (!root) return;
  const repoSkill = path.join(root, '.agents', 'skills', 'verify', 'SKILL.md');
  const text = codex.readText(repoSkill);
  if (text === null) {
    add('info', 'Codex: このリポジトリに .agents/skills/verify がありません（node scripts/install.js --agent codex --repo-skill で置き方を確認できます）');
    return;
  }
  const same = text === codex.readText(TEMPLATE);
  add('ok', `Codex: このリポジトリに verify スキルがあります（.agents/skills/verify。${same ? '雛形と同じ' : '雛形から変更あり'}）`);
}

function checkAgentsMd(add, home) {
  const file = codex.agentsFile(home);
  const text = codex.readText(file);
  const ours = text === null ? 0 : text.split(/\r?\n/).filter((l) => codex.AGENTS_LINE_RE.test(l)).length;
  if (path.basename(file) === 'AGENTS.override.md') add('info', `Codex: ${file} があるため、${path.join(home, 'AGENTS.md')} は読まれません`);
  if (ours >= 2) add('ok', `Codex: ${file} に verify-layer の 2 行があります`);
  else add('info', `Codex: ${file} に verify-layer の行が${ours ? '一部しか' : ''}ありません（node scripts/install.js --agent codex --agents-md --apply）`);
  if (text !== null && Buffer.byteLength(text) > AGENTS_MAX_BYTES) add('warn', `Codex: ${file} が 32 KiB を超えています。既定の project_doc_max_bytes で末尾が読まれず、追記した行が落ちることがあります`);
}

function checkCodex(add, root, env = process.env) {
  const home = codex.codexHome(env);
  if (!fs.existsSync(home) && codex.codexVersion(env) === null) {
    add('info', `Codex: ${home} も codex コマンドもないため、Codex の項目は飛ばしました`);
    return;
  }
  checkVersion(add, env);
  checkHooks(add, home, root, env);
  checkProjectTrust(add, home, root);
  checkSkill(add, root);
  checkAgentsMd(add, home);
}

module.exports = { checkCodex };
