#!/usr/bin/env node
'use strict';
// agent-verify-layer entry point (Node 18+, standard library only).
//   vl.js hook skill | hook commit | hook expand   (Claude Code hooks; never block work)
//   vl.js report [--json] [--days N] [--repo DIR]
//   vl.js doctor [--json] [--repo DIR]
const { readStdin, parseJsonObject, shortError } = require('./lib/io');

const HOOK_USAGE = 'usage: vl.js hook skill | hook commit | hook expand';

// A hook must never stop the user's work: any failure becomes exit 0 plus one short stderr line.
async function runHook(args) {
  try {
    process.on('uncaughtException', (e) => {
      process.stderr.write(`[verify-layer] ${shortError(e)}\n`);
      process.exit(0);
    });
    const [sub] = args;
    const input = parseJsonObject(await readStdin());
    const hooks = require('./lib/hooks');
    let out = null;
    if (sub === 'skill') out = hooks.handleSkill(input);
    else if (sub === 'commit') out = hooks.handleCommit(input);
    else if (sub === 'expand') out = hooks.handleExpand(input);
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
    else flags._.push(a);
  }
  return flags;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'hook') return runHook(rest);
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
  if (cmd === 'doctor') {
    process.exitCode = require('./lib/doctor').run(parseFlags(rest));
    return;
  }
  process.stderr.write('usage: vl.js <hook|report|doctor> ...\n');
  process.exitCode = cmd ? 2 : 0;
}

main(process.argv.slice(2));
