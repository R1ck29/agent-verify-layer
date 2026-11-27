#!/usr/bin/env node
'use strict';
// agent-verify-layer entry point (Node 18+, standard library only).
//   vl.js hook skill|commit|expand|start|stop [--agent claude|codex]
//   vl.js verify-diff --agent <host> --session <id> --case <JSON> [--request <id>]
//   vl.js mark verify [--agent claude|codex] [--repo DIR]   (run after the verify checks passed)
//   vl.js report [--json] [--days N] [--repo DIR]
//   vl.js doctor [--json] [--repo DIR]
const { readStdin, parseJsonObject, shortError } = require('./lib/io');

const HOOK_USAGE = 'usage: vl.js hook skill|commit|expand|start|stop';

// Hook infrastructure errors fail open. Only a successful v0.2 Stop can request a block.
async function runHook(args) {
  try {
    process.on('uncaughtException', (e) => {
      process.stderr.write(`[verify-layer] ${shortError(e)}\n`);
      process.exit(0);
    });
    const [sub, ...rest] = args;
    const i = rest.indexOf('--agent');
    const opts = { agent: i >= 0 ? rest[i + 1] : undefined };
    const input = parseJsonObject(await readStdin());
    const hooks = require('./lib/hooks');
    let out = null;
    if (sub === 'skill') out = hooks.handleSkill(input, opts);
    else if (sub === 'commit') out = hooks.handleCommit(input, opts);
    else if (sub === 'expand') out = hooks.handleExpand(input, opts);
    else if (sub === 'start') out = require('./lib/stop').handleStart(input, opts);
    else if (sub === 'stop') out = require('./lib/stop').handleStop(input, opts);
    else process.stderr.write(`[verify-layer] ${HOOK_USAGE}\n`);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (e) {
    process.stderr.write(`[verify-layer] ${shortError(e)}\n`);
  }
  process.exitCode = 0;
}

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--days') {
      flags.days = Number(args[++i]);
      if (!(flags.days > 0)) flags.bad = '--days には正の数を指定してください';
    }
    else if (a === '--repo') flags.repo = args[++i];
    else if (a === '--agent') flags.agent = args[++i];
    else flags._.push(a);
  }
  return flags;
}

function runVerifyDiff(args) {
  try {
    const { parseArgs } = require('node:util');
    const { values: flags } = parseArgs({ args, options: {
      agent: { type: 'string' }, session: { type: 'string' }, request: { type: 'string' },
      repo: { type: 'string' }, case: { type: 'string' }, withdraw: { type: 'string' },
      reason: { type: 'string' }, 'intentional-change': { type: 'string' }, 'request-quote': { type: 'string' },
      'generate-config': { type: 'boolean' }, status: { type: 'boolean' },
    } });
    const actions = [flags.case, flags.withdraw, flags['intentional-change'], flags['generate-config'], flags.status];
    if (actions.filter(Boolean).length !== 1) {
      throw new Error('Use one of --case <JSON>, --withdraw <caseId>, --intentional-change <testId>, --status, or --generate-config');
    }
    const { repoRoot, scrubbedEnv } = require('./lib/git');
    const { loadV2Config } = require('./lib/config');
    const verify = require('./lib/verify-diff');
    const root = repoRoot(flags.repo || process.cwd(), { fullEnv: scrubbedEnv() });
    if (!root) throw new Error('Run inside a Git repository or pass --repo');
    let result;
    if (flags['generate-config']) {
      result = verify.generateConfig(root);
    } else {
      if (loadV2Config(root).mode === 'off') throw new Error('Verify v0.2 is off for this repository');
      const session = { agent: flags.agent, session: flags.session, request: flags.request };
      if (!['claude', 'codex'].includes(session.agent) || !session.session) {
        throw new Error('Provide --agent and --session from the request start context');
      }
      if (flags.case) {
        const fs = require('node:fs');
        const content = fs.readFileSync(flags.case, 'utf8');
        result = verify.verifyCase(root, session, JSON.parse(content));
      } else if (flags.withdraw) {
        result = verify.withdrawCase(root, session, flags.withdraw, flags.reason);
      } else if (flags['intentional-change']) {
        result = verify.recordIntentional(root, session, flags['intentional-change'], flags['request-quote'], flags.reason);
      } else {
        result = verify.finalStatus(root, session);
      }
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.status === 'error' ? 2 : result.status === 'mismatch' ? 1 : 0;
  } catch (error) {
    process.stderr.write('[verify-layer] ' + shortError(error) + '\n');
    return 2;
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'hook') return runHook(rest);
  if (cmd === 'verify-diff') {
    process.exitCode = runVerifyDiff(rest);
    return;
  }
  if (cmd === 'report') {
    const flags = parseFlags(rest);
    if (flags.bad) {
      process.stderr.write(flags.bad + '\n');
      process.exitCode = 2;
      return;
    }
    process.exitCode = require('./lib/report').run(flags);
    return;
  }
  if (cmd === 'mark') {
    process.exitCode = require('./lib/mark').run(parseFlags(rest));
    return;
  }
  if (cmd === 'doctor') {
    process.exitCode = require('./lib/doctor').run(parseFlags(rest));
    return;
  }
  process.stderr.write('usage: vl.js <hook|verify-diff|mark|report|doctor> ...\n');
  process.exitCode = cmd ? 2 : 0;
}

main(process.argv.slice(2));
