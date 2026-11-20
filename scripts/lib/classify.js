'use strict';
const { matchAny } = require('./glob');

// Judges one commit against the latest recorded verify run (design source: the verify run is
// tied to the HASH OF THE WORKING TREE; one character changed afterwards invalidates it).
//   paths        files changed by the commit (null = unreadable)
//   run          latest verify ledger row (has .tree) or null
//   worktreeTree hash of the working tree now (null = snapshot failed)
//   headTree     tree of the commit just made
//   diffNames    (tree) => Set of paths differing between that tree and HEAD, or null if unreachable
// verified = run.tree equals the working-tree hash. Two side figures keep the weaker views visible
// without replacing the measurement: paths_match (the committed files are byte-identical to what
// was verified) and head_tree_match (the commit's whole tree is the verified tree).
// skipped wins over none: docs/tests-only commits are outside the standard "run /verify before
// commit" instruction, so they must not count as unverified. paths === null is "unknown", never skipped.
function classify({ paths, run, skipGlobs, diffNames, worktreeTree, headTree }) {
  if (paths === null) return { result: 'unknown', stale_files: null, warn: 'paths-unavailable' };
  if (paths.every((p) => matchAny(skipGlobs, p))) return { result: 'skipped', stale_files: 0 };
  if (!run || !run.tree) return { result: 'none', stale_files: 0 };
  if (worktreeTree === null || worktreeTree === undefined) return { result: 'unknown', stale_files: null, warn: 'snapshot-unavailable' };
  const head_tree_match = headTree ? headTree === run.tree : null;
  if (run.tree === worktreeTree) return { result: 'verified', stale_files: 0, paths_match: true, head_tree_match };
  const changed = diffNames(run.tree);
  if (changed === null) return { result: 'stale', stale_files: null, paths_match: null, head_tree_match, warn: 'tree-unreachable' };
  const stale = paths.filter((p) => changed.has(p)).length;
  return { result: 'stale', stale_files: stale, paths_match: stale === 0, head_tree_match };
}

// Latest verify run recorded after `sinceTs` (exclusive), or null.
function latestRun(rows, sinceTs) {
  let best = null;
  for (const r of rows) {
    if (r.kind !== 'run' || r.skill !== 'verify' || typeof r.ts !== 'number') continue;
    if (sinceTs !== null && r.ts <= sinceTs) continue;
    if (!best || r.ts >= best.ts) best = r;
  }
  return best;
}

module.exports = { classify, latestRun };
