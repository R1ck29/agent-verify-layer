'use strict';

const path = require('node:path');
const { loadV2Config } = require('./config');
const { repoRoot, scrubbedEnv } = require('./git');
const { requestTransaction } = require('./ledger');
const { resolveAgent } = require('./hooks');
const { quoteArg } = require('./shellquote');
const { begin, finalStatus } = require('./verify-diff');

const CLI = path.resolve(__dirname, '..', 'vl.js');
const labels = {
  verified: '検証済み',
  unverified: '未検証',
  stale: '未検証（検証後の変更）',
  unsupported: '未検証（対応外ランナー）',
  withdrawn: '未検証（ケース取り下げ）',
  intentional: '未検証（意図した変更）',
};

function command(session, request) {
  return [
    'node', CLI, 'verify-diff', '--agent', session.agent, '--session', session.session, '--request', request,
  ].map((word) => quoteArg(word)).join(' ');
}

function handleStart(input, opts) {
  if (input.hook_event_name !== 'UserPromptSubmit' || !input.session_id) return null;
  const root = repoRoot(input.cwd || process.cwd(), { fullEnv: scrubbedEnv() });
  if (!root) return null;
  const config = loadV2Config(root);
  if (config.mode === 'off') return null;
  const session = { agent: resolveAgent(opts.agent, input), session: input.session_id };
  const state = begin(root, session, config, input.prompt);
  if (state.config.runner === 'unsupported') return null;
  return { hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: `[verify-layer] v0.2 ${state.config.mode} / ${state.config.runner} / ${state.id}。コード・設定を変更したら verify2 スキルに従い、${command(session, state.id)} --case <JSON> で前後を確認してください。`,
  } };
}

function reasonText(result, cli, id) {
  return [
    '[verify-layer] ' + labels[result.status],
    result.reason,
    result.openFailures?.length && '未解消ケース ' + result.openFailures.join(', '),
    result.regressions?.length && '既存テストの回帰 ' + result.regressions.join(', '),
    '実装が誤っている可能性が最も高い境界入力を探し、公開入口で変更前後を比較してください。',
    `依頼 ID ${id} をファイル名に含め、境界候補を 3〜5 件列挙してください。指定 assertion はテスト本体の直下で 1 回、公開入口を直接呼び出し、期待値はリテラルにします。pytest は assert、unittest は self.assertEqual、Node は t.plan(1) と t.assert.strictEqual または deepStrictEqual を使います。`,
    'ケース JSON の input.args と input.kwargs に型付きの値を書き、辞書・オブジェクト・kwargs は順序を保つ [キー, 型付き値] の配列にします。引数は直列化でき、可変参照の共有や凍結などの特殊な属性がない値を使います。',
    '新規データや前後に同じ内容を置く非保護データは inputFiles に列挙してください。未列挙の参照も内容、権限、操作対象、子プロセスの参照を前後で照合し、失敗登録時に固定します。',
    cli + ' --case <JSON>',
    '異なるケース ID は最大 3 件で、入口到達後の比較失敗は入力・期待値・テスト・参照状態を固定します。誤った期待値は次で取り下げ、理由を報告してください。',
    cli + ' --withdraw <caseId> --reason "<理由>"',
  ].filter(Boolean).join('\n');
}

function handleStop(input, opts) {
  if (input.hook_event_name !== 'Stop' || !input.session_id) return null;
  const root = repoRoot(input.cwd || process.cwd(), { fullEnv: scrubbedEnv() });
  if (!root || loadV2Config(root).mode === 'off') return null;
  const session = { agent: resolveAgent(opts.agent, input), session: input.session_id };
  try {
    return finalStatus(root, session, (result, state, save) => {
      const shouldBlock = ['unverified', 'stale'].includes(result.status) &&
        state.config.mode === 'enforce' && !input.stop_hook_active && !state.interventions;
      if (shouldBlock) state.interventions += 1;
      state.stop = { ...result, label: labels[result.status], blocked: shouldBlock,
        count: (state.stop?.count ?? 0) + 1 };
      save(state);
      if (!shouldBlock) return null;
      return { decision: 'block', reason: reasonText(result, command(session, state.id), state.id) };
    });
  } catch (error) {
    try {
      requestTransaction(root, session.agent, session.session, (state, save) => {
        if (!state) return;
        state.stop = { status: 'error', label: '未検証（hook 失敗）', reason: error.message, blocked: false,
          count: (state.stop?.count ?? 0) + 1 };
        save(state);
      });
    } catch {
      // The host can continue even when the request ledger is not writable.
    }
    return null;
  }
}

module.exports = { handleStart, handleStop };
