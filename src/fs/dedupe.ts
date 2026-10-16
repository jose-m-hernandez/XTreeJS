// Content-hash-based duplicate detection and merge planning.
//
// Born from a real cleanup job: several old backup copies of a "Sites"
// folder tree, with cosmetic differences (.DS_Store, AppleDouble ._* files,
// Windows thumbs.db) masking whether the real content was actually the
// same. This module answers "is A the same as B" and "what would merging
// N folders into one actually produce" without guessing -- a file is only
// ever considered a duplicate when its SHA-256 matches exactly, and a path
// that disagrees across sources is surfaced as a conflict rather than
// silently resolved by picking one side.

import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';

export type JunkPredicate = (name: string) => boolean;

// Filesystem noise that differs between copies without representing real
// content: macOS Finder/AppleDouble files and the Windows thumbnail cache.
export const isJunkFile: JunkPredicate = (name) =>
  name === '.DS_Store' || name.startsWith('._') || name.toLowerCase() === 'thumbs.db';

export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// relative path -> sha256 content hash
export type FileManifest = Map<string, string>;

export async function scanTree(
  root: string,
  isJunk: JunkPredicate = isJunkFile
): Promise<FileManifest> {
  const manifest: FileManifest = new Map();

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (isJunk(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(root, full);
        manifest.set(rel, await hashFile(full));
      }
    }
  }

  await walk(root);
  return manifest;
}

export interface TreeComparison {
  /** paths present only in A */
  onlyInA: string[];
  /** paths present only in B */
  onlyInB: string[];
  /** paths present in both with matching content */
  identical: string[];
  /** paths present in both, but content differs -- needs a human decision */
  conflicts: string[];
}

export function compareManifests(a: FileManifest, b: FileManifest): TreeComparison {
  const onlyInA: string[] = [];
  const identical: string[] = [];
  const conflicts: string[] = [];

  for (const [rel, hash] of a) {
    if (!b.has(rel)) {
      onlyInA.push(rel);
    } else if (b.get(rel) === hash) {
      identical.push(rel);
    } else {
      conflicts.push(rel);
    }
  }

  const onlyInB = [...b.keys()].filter((rel) => !a.has(rel));

  onlyInA.sort();
  onlyInB.sort();
  identical.sort();
  conflicts.sort();
  return { onlyInA, onlyInB, identical, conflicts };
}

/** Is `a` a subset of `b` -- i.e. safe to discard `a` outright? */
export function isRedundant(comparison: TreeComparison): boolean {
  return comparison.onlyInA.length === 0 && comparison.conflicts.length === 0;
}

// Shared by the CLI and the TUI report pane so both surfaces describe a
// comparison identically.
export function formatComparisonLines(
  labelA: string,
  labelB: string,
  cmp: TreeComparison
): string[] {
  const lines: string[] = [];
  lines.push(`${labelA}  vs  ${labelB}`);
  lines.push(`  identical: ${cmp.identical.length}`);
  lines.push(`  only in ${labelA}: ${cmp.onlyInA.length}`);
  for (const rel of cmp.onlyInA) lines.push(`    ${rel}`);
  lines.push(`  only in ${labelB}: ${cmp.onlyInB.length}`);
  for (const rel of cmp.onlyInB) lines.push(`    ${rel}`);
  lines.push(`  conflicts (same path, different content): ${cmp.conflicts.length}`);
  for (const rel of cmp.conflicts) lines.push(`    ${rel}`);
  lines.push('');
  lines.push(
    isRedundant(cmp)
      ? `${labelA} is a redundant subset of ${labelB} -- safe to discard ${labelA}.`
      : `${labelA} has content not present in ${labelB} -- do not discard without reviewing the differences above.`
  );
  return lines;
}

export interface MergeAction {
  type: 'copy' | 'conflict-copy';
  relPath: string;
  sourceRoot: string;
  /** where under the destination this lands; differs from relPath only for conflict-copy */
  destRelPath: string;
}

export interface MergePlan {
  actions: MergeAction[];
  totalUniquePaths: number;
  duplicateCopiesSkipped: number;
  conflicts: Array<{ relPath: string; sources: string[] }>;
}

// For any relative path found in more than one source: if every occurrence
// hashes the same, it's a true duplicate (kept once). If any occurrence
// disagrees, every version is kept side by side with a "(CONFLICT-<source>)"
// suffix rather than picking a winner -- silent data loss is worse than an
// extra file to review by hand.
export async function planMerge(
  sourceRoots: string[],
  isJunk: JunkPredicate = isJunkFile
): Promise<MergePlan> {
  const manifests = new Map<string, FileManifest>();
  for (const root of sourceRoots) {
    manifests.set(root, await scanTree(root, isJunk));
  }

  const allRels = new Set<string>();
  for (const m of manifests.values()) {
    for (const rel of m.keys()) allRels.add(rel);
  }

  const actions: MergeAction[] = [];
  const conflicts: Array<{ relPath: string; sources: string[] }> = [];
  let duplicateCopiesSkipped = 0;

  for (const rel of [...allRels].sort()) {
    const present = sourceRoots
      .filter((root) => manifests.get(root)!.has(rel))
      .map((root) => ({ root, hash: manifests.get(root)!.get(rel)! }));

    const hashes = new Set(present.map((p) => p.hash));

    if (hashes.size === 1) {
      actions.push({
        type: 'copy',
        relPath: rel,
        sourceRoot: present[0].root,
        destRelPath: rel,
      });
      duplicateCopiesSkipped += present.length - 1;
    } else {
      conflicts.push({ relPath: rel, sources: present.map((p) => p.root) });
      const ext = path.extname(rel);
      const base = rel.slice(0, rel.length - ext.length);
      for (const { root } of present) {
        const tag = path.basename(root).replace(/\s+/g, '_');
        actions.push({
          type: 'conflict-copy',
          relPath: rel,
          sourceRoot: root,
          destRelPath: `${base} (CONFLICT-${tag})${ext}`,
        });
      }
    }
  }

  return {
    actions,
    totalUniquePaths: allRels.size,
    duplicateCopiesSkipped,
    conflicts,
  };
}

export interface MergeExecutionResult {
  copied: number;
  errors: string[];
}

export async function executeMergePlan(
  plan: MergePlan,
  destRoot: string
): Promise<MergeExecutionResult> {
  let copied = 0;
  const errors: string[] = [];

  for (const action of plan.actions) {
    const src = path.join(action.sourceRoot, action.relPath);
    const dest = path.join(destRoot, action.destRelPath);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      // Preserve the source's mtime so the merged copy still reflects when
      // the content was actually last touched, not when it was merged.
      const stat = await fs.stat(src);
      await fs.utimes(dest, stat.atime, stat.mtime);
      copied++;
    } catch (err: any) {
      errors.push(`${action.relPath}: ${err.message}`);
    }
  }

  return { copied, errors };
}
