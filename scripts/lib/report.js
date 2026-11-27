'use strict';
const path = require('node:path');
const { repoRoot, git } = require('./git');
const ledger = require('./ledger');

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);

// Pure aggregation over ledger rows plus the list of commit SHAs git log shows for the same period.
function summarize(rows, logShas) {
  const commits = rows.filter((r) => r.kind === 'commit').map((r) => {
    // Old hooks could call a partial commit verified because the working tree still matched.
    if (r.result === 'verified' && r.head_tree_match === false) {
      return { ...r, result: 'stale', stale_files: null, paths_match: null };
    }
    return r;
  });
  const runs = rows.filter((r) => r.kind === 'run');
  const results = { verified: 0, stale: 0, none: 0, skipped: 0, unknown: 0 };
  for (const c of commits) if (c.result in results) results[c.result]++;
  const judged = results.verified + results.stale + results.none; // skipped (outside the instruction) and unknown (git could not tell) stay out of the denominator
  // mark rows (`via: "mark"`) record when the checks passed; they are not extra verify starts.
  const allVerify = runs.filter((r) => r.skill === 'verify');
  const verifyRuns = allVerify.filter((r) => r.via !== 'mark');
  const marks = allVerify.filter((r) => r.via === 'mark');
  const agents = {};
  for (const c of commits) {
    const a = c.agent || 'claude'; // rows before the agent field were all Claude Code
    agents[a] = (agents[a] || 0) + 1;
  }

  const staleSizes = commits.filter((c) => c.result === 'stale' && Number.isFinite(c.stale_files)).map((c) => c.stale_files);
  // Items shown to the agent, counted per route. The verify hook shows them at verify start; `mark`
  // shows them at check time and is the ONLY route on Codex. A mark that repeats an item the hook
  // already showed for the same tree in the same session is counted in by_route only.
  const fired = {};
  const byRoute = { hook: {}, mark: {} };
  const shownByHook = new Set();
  const sorted = [...allVerify].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const r of sorted) {
    const route = r.via === 'mark' ? 'mark' : 'hook';
    for (const id of r.fired || []) {
      byRoute[route][id] = (byRoute[route][id] || 0) + 1;
      const key = r.session && r.tree ? JSON.stringify([r.agent || 'claude', r.session, r.tree, id]) : null;
      if (key && route === 'hook') shownByHook.add(key);
      else if (key && shownByHook.has(key)) continue;
      fired[id] = (fired[id] || 0) + 1;
    }
  }
  const ms = rows.filter((r) => Number.isFinite(r.ms)).map((r) => r.ms);

  const recorded = new Set(commits.map((c) => c.sha));
  const logSet = logShas == null ? null : new Set(logShas);
  const inLog = logSet ? [...recorded].filter((s) => logSet.has(s)).length : null;

  return {
    commits: { total: commits.length, ...results },
    commits_by_agent: agents,
    // Compare the changed paths and the working tree independently of the commit-wide verdict.
    stale_paths_match: commits.filter((c) => c.result === 'stale' && c.paths_match === true).length,
    verified_head_exact: commits.filter((c) => c.result === 'verified' && c.head_tree_match === true).length,
    worktree_tree_match: commits.filter((c) => c.worktree_tree_match === true).length,
    verified_by_mark: commits.filter((c) => c.result === 'verified' && c.basis === 'mark').length,
    verified_rate_pct: pct(results.verified, judged),
    session_verify_rate_pct: pct(commits.filter((c) => c.session_verify && c.result !== 'skipped' && c.result !== 'unknown').length, judged),
    session_code_review_rate_pct: pct(commits.filter((c) => c.session_code_review && c.result !== 'skipped' && c.result !== 'unknown').length, judged),
    runs: {
      verify: verifyRuns.length,
      verify_via_model: verifyRuns.filter((r) => r.via === 'model').length,
      verify_via_user: verifyRuns.filter((r) => r.via === 'user').length,
      verify_marked: marks.length,
      code_review: runs.filter((r) => r.skill === 'code-review').length,
    },
    stale_files: { median: percentile(staleSizes, 0.5), max: staleSizes.length ? Math.max(...staleSizes) : null },
    self_check_change_commits: commits.filter((c) => c.self_check_change).length,
    checklist_fired: fired,
    checklist_fired_by_route: byRoute,
    checklist_warnings: rows.reduce((n, r) => n + (Number.isFinite(r.checklist_warnings) ? r.checklist_warnings : 0), 0),
    hook_ms: { p50: percentile(ms, 0.5), p95: percentile(ms, 0.95), max: ms.length ? Math.max(...ms) : null },
    reconcile: {
      git_log_commits: logSet ? logSet.size : null,
      recorded_in_log: inLog,
      not_recorded: logSet ? logSet.size - inLog : null,
      capture_rate_pct: logSet ? pct(inLog, logSet.size) : null,
      recorded_not_in_log: logSet ? recorded.size - inLog : null,
    },
  };
}

function formatText(s, meta) {
  const L = [];
  L.push(`verify-layer report  (${meta.repo})`);
  L.push(`期間: ${meta.from ? new Date(meta.from * 1000).toISOString().slice(0, 10) : '-'} 〜 今日（台帳 ${meta.rows} 行）`);
  L.push('');
  const c = s.commits;
  L.push(`コミット（台帳）: ${c.total} 件 — verified ${c.verified} / stale ${c.stale} / none ${c.none} / skipped ${c.skipped}${c.unknown ? ` / unknown ${c.unknown}（判定に必要な Git 情報を取得できなかった）` : ''}`);
  L.push(`  （参考）hook 実行時の作業ツリー全体が検証時と同じもの ${s.worktree_tree_match} 件 / stale のうちコミットしたファイルが検証時と同じもの ${s.stale_paths_match} 件`);
  L.push(`  verified 率（skipped・unknown を除く）: ${s.verified_rate_pct ?? '-'}%`);
  L.push(`  同じセッションで verify があった率: ${s.session_verify_rate_pct ?? '-'}% / code-review があった率: ${s.session_code_review_rate_pct ?? '-'}%`);
  L.push(`  stale の大きさ（コミット内の差のあるファイル数）: 中央値 ${s.stale_files.median ?? '-'} / 最大 ${s.stale_files.max ?? '-'}`);
  L.push(`  チェック自体を触ったコミット: ${s.self_check_change_commits} 件`);
  const byAgent = Object.entries(s.commits_by_agent);
  if (byAgent.length > 1 || (byAgent.length === 1 && byAgent[0][0] !== 'claude')) L.push(`  エージェント別: ${byAgent.map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  L.push(`  verified のうち、確認後の mark で判定したもの: ${s.verified_by_mark} 件`);
  L.push(`verify の実行: ${s.runs.verify} 回（モデル経由 ${s.runs.verify_via_model} / 利用者 ${s.runs.verify_via_user}）、確認後の mark: ${s.runs.verify_marked} 回、code-review: ${s.runs.code_review} 回`);
  const ids = Object.entries(s.checklist_fired).sort((a, b) => b[1] - a[1]);
  L.push(`チェックリスト項目の発火: ${ids.length ? ids.map(([k, v]) => `${k}×${v}`).join(', ') : 'なし'}${s.checklist_warnings ? `（不正な項目・正規表現の警告 ${s.checklist_warnings} 件）` : ''}`);
  L.push(`hook の所要時間(ms): p50 ${s.hook_ms.p50 ?? '-'} / p95 ${s.hook_ms.p95 ?? '-'} / 最大 ${s.hook_ms.max ?? '-'}`);
  const r = s.reconcile;
  L.push('');
  if (r.git_log_commits === null) {
    L.push('git log との突き合わせ: 履歴を取得不能');
  } else {
    L.push(`git log との突き合わせ（推定）: この期間のコミット ${r.git_log_commits} 件のうち台帳にあるのは ${r.recorded_in_log} 件（拾えた割合 ${r.capture_rate_pct ?? '-'}%）`);
    L.push(`  台帳にない ${r.not_recorded} 件には、コマンド結果から確認できなかったコミットや、hook が動かなかったコミットが含まれます`);
    if (r.recorded_not_in_log) L.push(`  台帳にあるが今の履歴にない ${r.recorded_not_in_log} 件は、amend・rebase・別ブランチのコミットです`);
  }
  return L.join('\n');
}

function run(flags) {
  const cwd = path.resolve(flags.repo || process.cwd());
  const root = repoRoot(cwd);
  if (!root) {
    process.stderr.write(`git リポジトリではありません: ${cwd}\n`);
    return 1;
  }
  let rows = ledger.readAll(root);
  // One start for both sides of the comparison: --days gives the period start; without it the
  // ledger's first row does. Deriving it from the first ledger row alone hid every commit the
  // ledger missed before that row (and all commits when the ledger was empty).
  let from = null;
  if (Number.isFinite(flags.days) && flags.days > 0) {
    from = Date.now() / 1000 - flags.days * 86400;
    rows = rows.filter((r) => typeof r.ts === 'number' && r.ts >= from);
  } else {
    from = rows.reduce((m, r) => (typeof r.ts === 'number' && (m === null || r.ts < m) ? r.ts : m), null);
  }
  const args = ['log', '--no-merges', '--format=%H'];
  if (from !== null) args.push(`--since=${new Date(from * 1000).toISOString()}`);
  const l = git(args, { cwd: root });
  const logShas = l.ok ? l.out.split('\n').filter(Boolean) : null;
  const summary = summarize(rows, logShas);
  if (flags.json) process.stdout.write(JSON.stringify({ repo: root, rows: rows.length, from, ...summary }, null, 2) + '\n');
  else process.stdout.write(formatText(summary, { repo: root, rows: rows.length, from }) + '\n');
  return 0;
}

module.exports = { summarize, percentile, run };
