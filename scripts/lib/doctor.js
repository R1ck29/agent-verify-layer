'use strict';
// `vl.js doctor`: read-only environment check + a synthetic run of every hook in a throw-away repo.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { git, repoRoot } = require('./git');
const { claudeDir, configPath, loadConfig } = require('./config');
const { isOwnHandler, readJsonFile, allHandlers, managedSettingsPath } = require('./settings');

const VL = path.resolve(__dirname, '..', 'vl.js');
const MIN_VERIFY_INSTRUCTION = [2, 1, 286];
const MIN_ONFAILURE = [2, 1, 295];

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text || '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function lt(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function tryRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true, shell: process.platform === 'win32' && cmd === 'claude' });
  return r.error || r.status !== 0 ? null : (r.stdout || '').trim();
}

const truthy = (v) => !!v && !['0', 'false', ''].includes(String(v).toLowerCase());

// Checks that need settings files: [{ label, file, data }] for the files that exist and parse.
function loadSettingsFiles(root) {
  const files = [
    ['managed', managedSettingsPath()],
    ['user', path.join(claudeDir(), 'settings.json')],
  ];
  if (root) {
    files.push(['project', path.join(root, '.claude', 'settings.json')]);
    files.push(['local', path.join(root, '.claude', 'settings.local.json')]);
  }
  return files.map(([label, file]) => ({ label, file, ...readJsonFile(file) }));
}

function checkSettings(add, files) {
  for (const f of files) {
    if (!f.exists) continue;
    if (f.error) {
      add('warn', `${f.label} settings を読めません（${f.file}）: ${f.error}`);
      continue;
    }
    const s = f.data;
    add('info', `${f.label} settings あり: ${f.file}`);
    if (f.label === 'managed' && s.allowManagedHooksOnly === true) add('ng', 'managed: allowManagedHooksOnly が有効です。利用者・プロジェクト・プラグインの hook は動きません（管理設定で強制有効にしたプラグインを除く）。管理者に配布を依頼してください');
    if (s.disableAllHooks === true) add('ng', `${f.label}: disableAllHooks が有効です。hook は動きません`);
    if (f.label === 'managed' && s.strictPluginOnlyCustomization) add('warn', `${f.label}: strictPluginOnlyCustomization があります（${JSON.stringify(s.strictPluginOnlyCustomization)}）。skills が含まれる場合、プロジェクトの verify は読み込まれず verify の実行率は 0 になります`);
    if (s.includeGitInstructions === false) add('ng', `${f.label}: includeGitInstructions が false です。コミット前に verify を実行する標準の指示が消えます`);
    const ov = s.skillOverrides && typeof s.skillOverrides === 'object' ? s.skillOverrides : {};
    for (const name of ['verify', 'simplify']) {
      if (ov[name] === 'user-invocable-only' || ov[name] === 'off') add('ng', `${f.label}: skillOverrides.${name} が ${ov[name]} です。Claude が呼べないので標準の指示が入りません`);
    }
    if (s.env && truthy(s.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS)) add('ng', `${f.label}: env に CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS があります。標準の指示が消えます`);
    if (s.enabledPlugins && typeof s.enabledPlugins === 'object') {
      for (const [k, v] of Object.entries(s.enabledPlugins)) if (/^verify-layer@/.test(k)) add(v === false ? 'warn' : 'info', `${f.label}: プラグイン ${k} = ${v}${v === false ? '（無効です）' : ''}`);
    }
  }
}

function checkWiring(add, files) {
  const own = [];
  const seen = new Set();
  const other = { 'PostToolUse(Bash/Skill)': 0, 'PreToolUse(Bash)': 0, UserPromptExpansion: 0 };
  for (const f of files) {
    if (!f.data) continue;
    for (const { event, group, handler } of allHandlers(f.data)) {
      if (isOwnHandler(handler)) {
        own.push(f.label);
        const hookArgs = Array.isArray(handler.args) ? handler.args : String(handler.command).split(/\s+/);
        seen.add(hookArgs.slice(hookArgs.findIndex((a) => /vl\.js["']?$/.test(a) ) + 1).join(' '));
        const script = hookArgs.map((a) => String(a).replace(/^["']|["']$/g, '')).find((a) => /vl\.js$/.test(a.replace(/\\/g, '/')));
        if (script && !fs.existsSync(String(script))) add('ng', `${f.label}: 登録された vl.js が存在しません: ${script}`);
        if (handler.command !== 'node' && Array.isArray(handler.args)) add('info', `${f.label}: 起動コマンドは ${handler.command}`);
      } else if (event === 'UserPromptExpansion') other.UserPromptExpansion++;
      else if (event === 'PreToolUse' && /Bash/.test(group.matcher || '')) other['PreToolUse(Bash)']++;
      else if (event === 'PostToolUse' && /Bash|Skill/.test(group.matcher || '')) other['PostToolUse(Bash/Skill)']++;
    }
  }
  const pluginOn = files.some((f) => f.data && f.data.enabledPlugins && Object.entries(f.data.enabledPlugins).some(([k, v]) => /^verify-layer@/.test(k) && v !== false));
  if (own.length) {
    add('ok', `settings.json に verify-layer の hook があります（${[...new Set(own)].join(', ')}）`);
    const need = ['hook run verify', 'hook run code-review', 'hook commit', 'hook expand'].filter((n) => !seen.has(n));
    if (need.length) add('warn', `hook が揃っていません。足りない: ${need.join(', ')}（install.js --apply で入れ直してください）`);
  }
  else if (pluginOn) add('ok', 'プラグイン verify-layer が有効です');
  else add('warn', 'verify-layer の hook が settings にもプラグインにも見つかりません（--plugin-dir で一時的に読み込んでいる場合は問題ありません）');
  const others = Object.entries(other).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`);
  if (others.length) add('info', `ほかの hook（並列に動きます。件数のみ）: ${others.join(', ')}`);
}

function checkSkills(add, root) {
  const home = claudeDir();
  for (const name of ['verify', 'simplify']) {
    for (const p of [path.join(home, 'skills', name, 'SKILL.md'), path.join(home, 'commands', `${name}.md`)]) {
      if (fs.existsSync(p)) add('warn', `個人用の ${name} があります（${p}）。すべてのリポジトリで、リポジトリ側の記録より優先されます`);
    }
  }
  if (!root) return;
  const skill = path.join(root, '.claude', 'skills', 'verify', 'SKILL.md');
  if (fs.existsSync(skill)) {
    let text = '';
    try {
      text = fs.readFileSync(skill, 'utf8');
    } catch {
      /* unreadable: treated as empty */
    }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (front && /^disable-model-invocation:\s*["']?true["']?\s*(#.*)?$/m.test(front[1])) add('ng', 'このリポジトリの verify に disable-model-invocation: true があります。標準の指示が入りません');
    else add('ok', 'このリポジトリに verify の記録があります（.claude/skills/verify/SKILL.md）');
  } else {
    add('info', 'このリポジトリには verify の記録がありません。/verify を 1 回実行し、記録された SKILL.md をコミットしてください');
  }
  const nested = git(['ls-files', '*/.claude/skills/verify/SKILL.md'], { cwd: root });
  if (nested.ok && nested.out.trim()) add('info', `入れ子の verify: ${nested.out.trim().split('\n').length} 件`);
}

function checkEnvironment(add) {
  const nodeV = parseVersion(process.versions.node);
  if (nodeV && nodeV[0] < 18) add('ng', `Node ${process.versions.node}: 18 以上が必要です`);
  else add('ok', `Node ${process.versions.node}`);
  if (!tryRun('node', ['--version'])) add('ng', 'PATH に node がありません。hook は command: "node" で起動するため、動きません');
  const g = parseVersion(tryRun('git', ['--version']));
  if (!g) add('ng', 'git が見つかりません');
  else if (lt(g, [2, 30, 0])) add('warn', `git ${g.join('.')}: 2.30 以上を推奨します`);
  else add('ok', `git ${g.join('.')}`);

  const cv = parseVersion(tryRun('claude', ['--version']));
  if (!cv) add('info', 'claude コマンドが見つかりません（版は確認できません）');
  else {
    add('info', `claude ${cv.join('.')}`);
    if (lt(cv, MIN_VERIFY_INSTRUCTION)) add('warn', `claude ${cv.join('.')}: 2.1.286 未満はコミット前の verify 指示がないため、verify の実行率は 0 になります（台帳は動きます）`);
    if (lt(cv, MIN_ONFAILURE)) add('warn', `claude ${cv.join('.')}: 2.1.295 未満は hook の onFailure を解釈しません`);
  }
  add('info', `OS: ${process.platform} ${os.release()}`);
  if (process.platform === 'win32') {
    const bash = process.env.CLAUDE_CODE_GIT_BASH_PATH || ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p));
    add('info', bash ? `Git Bash あり: ${bash}` : 'Git Bash が見つかりません（Bash ツールが無く、PowerShell ツールだけで動く構成の可能性）。hook は Bash|PowerShell の両方に配線済みです');
    add('info', `CLAUDE_CODE_USE_POWERSHELL_TOOL=${process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL || '(未設定)'}`);
  }
  if (truthy(process.env.CLAUDE_CODE_USE_BEDROCK)) add('info', '推論経路: `CLAUDE_CODE_USE_BEDROCK`（フラグを取りに行かないため、標準の verify 指示は既定値に従います）');
  if (truthy(process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS)) add('ng', '環境変数 CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS が有効です。標準の verify 指示が消えます');
  const mode = loadConfig().mode;
  add(mode === 'off' ? 'warn' : 'info', `config: ${configPath()}（mode=${mode}${mode === 'off' ? '。off の間は台帳に何も書きません' : ''}）`);
}

// Feeds a sample input of each hook event to vl.js inside a throw-away repo.
function checkHooksSmoke(add) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-doctor-'));
  const cfgDir = path.join(dir, 'cfg');
  fs.mkdirSync(cfgDir);
  const env = {
    ...process.env,
    VL_CONFIG_DIR: cfgDir,
    GIT_AUTHOR_NAME: 'doctor', GIT_AUTHOR_EMAIL: 'doctor@example.invalid',
    GIT_COMMITTER_NAME: 'doctor', GIT_COMMITTER_EMAIL: 'doctor@example.invalid',
  };
  const repo = path.join(dir, 'repo');
  try {
    fs.mkdirSync(repo);
    const sh = (args) => git(args, { cwd: repo, env });
    sh(['init', '-q']);
    fs.writeFileSync(path.join(repo, 'a.js'), 'a\n');
    sh(['add', '-A']);
    sh(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
    fs.appendFileSync(path.join(repo, 'a.js'), 'b\n');

    const base = { session_id: 'doctor', cwd: repo, permission_mode: 'default' };
    const samples = [
      ['hook run verify', ['hook', 'run', 'verify'], { ...base, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'verify' }, tool_response: {} }],
      ['hook run code-review', ['hook', 'run', 'code-review'], { ...base, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'code-review' }, tool_response: {} }],
      ['hook expand', ['hook', 'expand'], { ...base, hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'verify', command_args: '', command_source: 'builtin', prompt: '/verify' }],
    ];
    for (const [label, args, input] of samples) {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [VL, ...args], { input: JSON.stringify(input), encoding: 'utf8', env, timeout: 15000, windowsHide: true });
      const out = (r.stdout || '').trim();
      let shapeOk = true;
      if (out) {
        try {
          const j = JSON.parse(out);
          const h = j && j.hookSpecificOutput;
          shapeOk = j && typeof j === 'object' && !('decision' in j) && (h === undefined || (typeof h.hookEventName === 'string' && typeof h.additionalContext === 'string'));
        } catch {
          shapeOk = false;
        }
      }
      if (r.status === 0 && shapeOk) add('ok', `${label}: 終了コード 0・出力の形 OK（${Date.now() - t0} ms）`);
      else add('ng', `${label}: 終了コード ${r.status}、出力 ${shapeOk ? 'OK' : '不正'} ${(r.stderr || '').split('\n')[0]}`);
    }
    // commit hook after a real commit
    sh(['add', '-A']);
    sh(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'second']);
    const r = spawnSync(process.execPath, [VL, 'hook', 'commit'], {
      input: JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m second' }, tool_response: {} }),
      encoding: 'utf8', env, timeout: 15000, windowsHide: true,
    });
    const ledgerFile = path.join(repo, '.git', 'claude-verify', 'ledger.jsonl');
    let rows = 0;
    try {
      rows = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).length;
    } catch {
      /* no ledger */
    }
    if (r.status === 0 && rows >= 4) add('ok', `hook commit: 台帳に行ができました（${rows} 行）`);
    else add('ng', `hook commit: 終了コード ${r.status}、台帳の行数 ${rows}（4 以上が期待値）`);
  } catch (e) {
    add('ng', `hook の疑似実行に失敗しました: ${String(e.message).split('\n')[0]}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  add('info', '`if` の当たり方と UserPromptExpansion の発火は、実際の Claude Code のセッションでしか確かめられません（INSTALL_FOR_CLAUDE.md の手順を参照）');
}

function run(flags) {
  const results = [];
  const add = (level, msg) => results.push({ level, msg });
  const root = repoRoot(path.resolve(flags.repo || process.cwd()));
  checkEnvironment(add);
  const files = loadSettingsFiles(root);
  checkSettings(add, files);
  checkWiring(add, files);
  checkSkills(add, root);
  checkHooksSmoke(add);

  const ng = results.filter((r) => r.level === 'ng').length;
  const warn = results.filter((r) => r.level === 'warn').length;
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ng, warn, results }, null, 2) + '\n');
  } else {
    const tag = { ok: '[OK]  ', info: '[INFO]', warn: '[WARN]', ng: '[NG]  ' };
    for (const r of results) process.stdout.write(`${tag[r.level]} ${r.msg}\n`);
    process.stdout.write(`\n結果: NG ${ng} 件 / WARN ${warn} 件\n`);
  }
  return ng ? 1 : 0;
}

module.exports = { run, parseVersion, lt };
