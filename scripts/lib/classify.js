'use strict';
const { matchAny } = require('./glob');

// Judges one commit against the latest recorded verify run.
//   paths     files changed by the commit
//   run       latest verify ledger row (has .tree) or null
//   diffNames (tree) => Set of paths differing between that tree and HEAD, or null if unreachable
// skipped wins over none: docs/tests-only commits are outside the standard
// "run /verify before commit" instruction, so they must not count as unverified.
function classify({ paths, run, skipGlobs, diffNames }) {
  if (paths.every((p) => matchAny(skipGlobs, p))) return { result: 'skipped', stale_files: 0 };
  if (!run || !run.tree) return { result: 'none', stale_files: 0 };
  const changed = diffNames(run.tree);
  if (changed === null) return { result: 'stale', stale_files: null, warn: 'tree-unreachable' };
  const stale = paths.filter((p) => changed.has(p)).length;
  return stale === 0 ? { result: 'verified', stale_files: 0 } : { result: 'stale', stale_files: stale };
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
