'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { allHandlers } = require('./settings');
const { quoteArg, splitCommand } = require('./shellquote');

const ROOT = path.resolve(__dirname, '..', '..');
const VL = path.join(ROOT, 'scripts', 'vl.js');
const EVENTS = new Map([['UserPromptSubmit', 'start'], ['Stop', 'stop']]);

function v02Groups(agent, nodeCmd) {
  const folder = agent === 'claude' ? 'hooks' : 'codex';
  const { hooks } = JSON.parse(fs.readFileSync(path.join(ROOT, folder, 'hooks.v02.json'), 'utf8'));
  return Object.entries(hooks).flatMap(([event, groups]) => groups.map((group) => ({
    event,
    group: {
      ...group,
      hooks: group.hooks.map((handler) => {
        if (agent === 'claude') {
          const [, ...args] = handler.args;
          return { ...handler, command: nodeCmd, args: [VL, ...args] };
        }
        const args = splitCommand(handler.command).slice(2);
        return { ...handler, command: `${quoteArg(nodeCmd)} ${quoteArg(VL, { always: true })} ${args.join(' ')}` };
      }),
    },
  })));
}

function v02Script(agent, handler, event, group, scriptPaths) {
  const sub = EVENTS.get(event);
  if (!sub || group?.matcher !== undefined || handler?.type !== 'command' || typeof handler.command !== 'string') return null;
  const args = agent === 'claude' ? handler.args : splitCommand(handler.command)?.slice(1);
  if (!Array.isArray(args) || args.length !== 5 || typeof args[0] !== 'string' ||
      args[1] !== 'hook' || args[2] !== sub || args[3] !== '--agent' || args[4] !== agent) return null;
  if (agent === 'codex' && (handler.args !== undefined ||
      handler.statusMessage !== (sub === 'start' ? 'verify-layer: capturing request' : 'verify-layer: checking request'))) return null;
  const script = args[0];
  return (scriptPaths ? scriptPaths.has(script) : path.basename(script.replace(/\\/g, '/')) === 'vl.js') ? script : null;
}

function diagnoseV02(add, label, agent, docs, active) {
  if (!active) return;
  const events = new Map();
  for (const doc of docs) {
    for (const { event, group, handler } of allHandlers(doc)) {
      const script = v02Script(agent, handler, event, group);
      if (!script) continue;
      events.set(event, (events.get(event) ?? 0) + 1);
      if (!fs.existsSync(script)) add('ng', `${label} v0.2: 登録された vl.js が存在しません: ${script}`);
    }
  }
  const count = [...EVENTS.keys()].map((event) => `${event}=${events.get(event) ?? 0}`).join(' / ');
  const complete = [...EVENTS.keys()].every((event) => events.get(event) === 1);
  add(complete ? 'ok' : 'warn', `${label} v0.2: 登録数 ${count}（設定ファイルの確認）`);
}

module.exports = { v02Groups, v02Script, diagnoseV02 };
