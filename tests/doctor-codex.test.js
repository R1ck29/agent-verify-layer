'use strict';
// `vl.js doctor`, Codex part. Throw-away HOME / CODEX_HOME and a fake codex command only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Repo, VL, INSTALL, ROOT, run, fakeCodex } = require('./helpers');

function t(name, fn) {
  test(name, async () => {
    const repo = new Repo();
    try {
      repo.write('src/a.js', 'x\n');
      repo.commit('init');
      repo.cx = repo.env.CODEX_HOME;
      await fn(repo);
    } finally {
      repo.cleanup();
    }
  });
}

const doctor = (repo, env = {}) => {
  const r = run(process.execPath, [VL, 'doctor', '--json'], { cwd: repo.dir, env: { ...repo.env, ...env } });
  const data = JSON.parse(r.stdout);
  const codex = data.results.filter((x) => /^Codex|^codex /.test(x.msg));
  const at = (level) => codex.filter((x) => x.level === level).map((x) => x.msg).join('\n');
  return { status: r.status, data, codex, at };
};
const install = (repo, args, env = {}) => run(process.execPath, [INSTALL, '--agent', 'codex', '--node', process.execPath, ...args], { cwd: repo.dir, env: { ...repo.env, ...env } });

t('no Codex: a single info line, no warning or error from the Codex part, exit 0', (repo) => {
  const d = doctor(repo);
  assert.equal(d.status, 0, JSON.stringify(d.data.results.filter((x) => x.level === 'ng')));
  assert.equal(d.codex.length, 1);
  assert.equal(d.codex[0].level, 'info');
  assert.match(d.codex[0].msg, /飛ばしました/);
});

t('Codex present but nothing installed: version, hooks feature, not-installed hints, no errors', (repo) => {
  fs.mkdirSync(repo.cx, { recursive: true });
  const d = doctor(repo, { VL_CODEX_BIN: fakeCodex(repo.home) });
  assert.equal(d.status, 0);
  assert.equal(d.at('ng'), '');
  assert.equal(d.at('warn'), '');
  assert.match(d.at('info'), /codex 0\.170\.0/);
  assert.match(d.at('info'), /features\.hooks は無効にされていません/);
  assert.match(d.at('info'), /hook は未導入/);
  assert.match(d.at('info'), /\.agents\/skills\/verify がありません/);
  assert.match(d.at('info'), /リポジトリの信頼 = 未登録/);
});

t('full Codex setup: hook, trust hint, project trust, repo skill and AGENTS.md lines are reported', (repo) => {
  fs.mkdirSync(repo.cx, { recursive: true });
  const bin = fakeCodex(repo.home);
  for (const args of [['--apply', '--agents-md'], ['--apply', '--repo-skill']]) assert.equal(install(repo, args, { VL_CODEX_BIN: bin }).status, 0);
  const key = JSON.stringify(repo.dir); // TOML basic string == JSON string for paths
  fs.writeFileSync(path.join(repo.cx, 'config.toml'), `model = "x"\n\n[projects.${key}]\ntrust_level = "trusted"\n`);
  const d = doctor(repo, { VL_CODEX_BIN: bin });
  assert.equal(d.status, 0, d.at('ng'));
  assert.match(d.at('ok'), /verify-layer の hook があります/);
  assert.match(d.at('ok'), /verify スキルがあります.*雛形と同じ/);
  assert.match(d.at('ok'), /2 行があります/);
  assert.match(d.at('info'), /\/hooks を開き/);
  assert.match(d.at('info'), /リポジトリの信頼 = trusted/);
});

t('hooks disabled in config.toml is an error once our hook is installed', (repo) => {
  fs.mkdirSync(repo.cx, { recursive: true });
  install(repo, ['--apply']);
  fs.writeFileSync(path.join(repo.cx, 'config.toml'), '[features]\nhooks = false\n');
  const d = doctor(repo);
  assert.equal(d.status, 1);
  assert.match(d.at('ng'), /hooks が無効/);
});

t('allow_managed_hooks_only, duplicate registration, missing vl.js, old version and a personal verify skill are flagged', (repo) => {
  fs.mkdirSync(repo.cx, { recursive: true });
  install(repo, ['--apply']);
  const own = JSON.parse(fs.readFileSync(path.join(repo.cx, 'hooks.json'), 'utf8'));
  fs.mkdirSync(path.join(repo.dir, '.codex'));
  fs.writeFileSync(path.join(repo.dir, '.codex', 'hooks.json'), JSON.stringify(own));
  const req = path.join(repo.home, 'requirements.toml');
  fs.writeFileSync(req, 'allow_managed_hooks_only = true\n');
  fs.mkdirSync(path.join(repo.home, '.agents', 'skills', 'verify'), { recursive: true });
  fs.writeFileSync(path.join(repo.home, '.agents', 'skills', 'verify', 'SKILL.md'), '---\nname: verify\ndescription: x\n---\n');
  let d = doctor(repo, { VL_CODEX_REQUIREMENTS: req, VL_CODEX_BIN: fakeCodex(repo.home, '0.160.2') });
  assert.match(d.at('ng'), /allow_managed_hooks_only/);
  assert.match(d.at('warn'), /2 か所/);
  assert.match(d.at('warn'), /個人用の verify/);
  assert.match(d.at('warn'), /codex 0\.160\.2/);

  const moved = JSON.stringify(own).split(JSON.stringify(VL).slice(1, -1)).join('/gone/scripts/vl.js');
  fs.writeFileSync(path.join(repo.cx, 'hooks.json'), moved);
  d = doctor(repo);
  assert.match(d.at('ng'), /vl\.js が存在しません/);
});

t('AGENTS.override.md is reported as the file Codex reads; an edited repo skill is still recognised', (repo) => {
  fs.mkdirSync(repo.cx, { recursive: true });
  fs.writeFileSync(path.join(repo.cx, 'AGENTS.override.md'), 'team rules\n');
  const dest = path.join(repo.dir, '.agents', 'skills', 'verify');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), fs.readFileSync(path.join(ROOT, 'codex', 'skills', 'verify', 'SKILL.md'), 'utf8') + '\n- local\n');
  const d = doctor(repo);
  assert.match(d.at('info'), /AGENTS\.override\.md があるため/);
  assert.match(d.at('ok'), /雛形から変更あり/);
  assert.equal(d.status, 0);
});

test('projectTrust reads [projects."<path>"] trust_level and ignores other projects', () => {
  const { projectTrust } = require('../scripts/lib/codex');
  const p = path.resolve('/w/repo');
  const toml = `[projects.${JSON.stringify(path.resolve('/w/other'))}]\ntrust_level = "untrusted"\n\n[projects.${JSON.stringify(p)}]\ntrust_level = "trusted"\n[x]\ntrust_level = "untrusted"\n`;
  assert.equal(projectTrust(toml, p), 'trusted');
  assert.equal(projectTrust(toml, path.resolve('/w/none')), null);
  assert.equal(projectTrust(`[projects.'${p}']\ntrust_level = "untrusted"\n`, p), 'untrusted');
  assert.equal(projectTrust(null, p), null);
});
