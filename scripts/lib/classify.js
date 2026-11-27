'use strict';
const { matchAny } = require('./glob');

// A commit is verified when its full tree equals the recorded verify tree.
// The current worktree and the committed paths are supplementary comparisons.
function classify({ paths, run, skipGlobs, diffNames, worktreeTree, headTree }) {
  if (paths === null) return { result: 'unknown', stale_files: null, warn: 'paths-unavailable' };
  if (paths.every((p) => matchAny(skipGlobs, p))) return { result: 'skipped', stale_files: 0 };
  if (!run || !run.tree) return { result: 'none', stale_files: 0 };
  const worktree_tree_match = worktreeTree ? worktreeTree === run.tree : null;
  if (!headTree) return { result: 'unknown', stale_files: null, worktree_tree_match, warn: 'commit-tree-unavailable' };
  const head_tree_match = headTree === run.tree;
  const matches = { head_tree_match, worktree_tree_match };
  if (head_tree_match) return { result: 'verified', stale_files: 0, paths_match: true, ...matches };
  const changed = diffNames(run.tree);
  if (changed === null) return { result: 'stale', stale_files: null, paths_match: null, ...matches, warn: 'tree-unreachable' };
  const stale = paths.filter((p) => changed.has(p)).length;
  return { result: 'stale', stale_files: stale, paths_match: stale === 0, ...matches };
}

// Latest verify run inside the open time window, before the target commit was observed.
function latestRun(rows, sinceTs, untilTs = Infinity, sha) {
  let best = null;
  for (const r of rows) {
    if (r.kind !== 'run' || r.skill !== 'verify' || !Number.isFinite(r.ts)) continue;
    if (sinceTs !== null && r.ts <= sinceTs) continue;
    if (r.ts >= untilTs || (sha && r.head_sha === sha)) continue;
    if (!best || r.ts >= best.ts) best = r;
  }
  return best;
}

module.exports = { classify, latestRun };
