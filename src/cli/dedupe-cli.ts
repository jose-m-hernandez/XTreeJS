// Non-interactive entry point for the dedupe feature: `xtree dedupe ...`.
// Kept separate from the TUI so it can run in scripts/CI without a
// terminal, and so the core logic in fs/dedupe.ts stays UI-agnostic.

import * as path from 'path';
import {
  scanTree,
  compareManifests,
  isRedundant,
  formatComparisonLines,
  planMerge,
  executeMergePlan,
} from '../fs/dedupe.js';

const USAGE = `Usage:
  xtree dedupe compare <dirA> <dirB>
      Compare two directory trees by content hash (ignoring .DS_Store,
      AppleDouble ._* files, and thumbs.db). Reports paths unique to each
      side and any path present in both with conflicting content. Exits
      with status 1 if dirA is NOT a redundant subset of dirB, 0 otherwise.

  xtree dedupe merge <destDir> <sourceDir> [<sourceDir> ...]
      Merge two or more directory trees into <destDir>, deduplicating any
      file whose content is identical everywhere it appears. A path with
      different content across sources is never silently resolved -- every
      version is written to <destDir> with a "(CONFLICT-<source>)" suffix
      for manual review. Sources are left untouched.`;

async function runCompare(args: string[]): Promise<number> {
  const [dirA, dirB] = args;
  if (!dirA || !dirB) {
    console.error(USAGE);
    return 2;
  }
  const a = await scanTree(path.resolve(dirA));
  const b = await scanTree(path.resolve(dirB));
  const cmp = compareManifests(a, b);
  for (const line of formatComparisonLines(dirA, dirB, cmp)) console.log(line);
  return isRedundant(cmp) ? 0 : 1;
}

async function runMerge(args: string[]): Promise<number> {
  const [destArg, ...sourceArgs] = args;
  if (!destArg || sourceArgs.length < 2) {
    console.error(USAGE);
    return 2;
  }
  const dest = path.resolve(destArg);
  const sources = sourceArgs.map((s) => path.resolve(s));

  const plan = await planMerge(sources);
  console.log(`Merging ${sources.length} sources into ${dest}`);
  console.log(`  unique paths: ${plan.totalUniquePaths}`);
  console.log(`  duplicate copies skipped: ${plan.duplicateCopiesSkipped}`);
  console.log(`  conflicts: ${plan.conflicts.length}`);
  for (const c of plan.conflicts) {
    console.log(`    ${c.relPath}  (differs across: ${c.sources.join(', ')})`);
  }

  const result = await executeMergePlan(plan, dest);
  console.log(`Copied ${result.copied} file(s).`);
  if (result.errors.length > 0) {
    console.error(`Errors:`);
    for (const e of result.errors) console.error(`  ${e}`);
    return 1;
  }
  if (plan.conflicts.length > 0) {
    console.log(
      `\n${plan.conflicts.length} conflict(s) were written as separate (CONFLICT-<source>) ` +
        `files -- review and resolve them by hand before treating the merge as final.`
    );
  }
  return 0;
}

export async function runDedupeCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case 'compare':
      return runCompare(rest);
    case 'merge':
      return runMerge(rest);
    default:
      console.error(USAGE);
      return 2;
  }
}
