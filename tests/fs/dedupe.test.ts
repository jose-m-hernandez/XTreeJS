import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  hashFile,
  scanTree,
  compareManifests,
  isRedundant,
  formatComparisonLines,
  planMerge,
  executeMergePlan,
  isJunkFile,
} from '../../src/fs/dedupe.js';

const TEST_DIR = '/tmp/claude/xtreejs-dedupe-test';
const A_DIR = path.join(TEST_DIR, 'a');
const B_DIR = path.join(TEST_DIR, 'b');
const C_DIR = path.join(TEST_DIR, 'c');
const DEST_DIR = path.join(TEST_DIR, 'merged');

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

beforeEach(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe('isJunkFile', () => {
  test('flags macOS and Windows filesystem noise', () => {
    expect(isJunkFile('.DS_Store')).toBe(true);
    expect(isJunkFile('._resume.pdf')).toBe(true);
    expect(isJunkFile('Thumbs.db')).toBe(true);
    expect(isJunkFile('thumbs.db')).toBe(true);
  });

  test('does not flag real files', () => {
    expect(isJunkFile('resume.pdf')).toBe(false);
    expect(isJunkFile('index.html')).toBe(false);
  });
});

describe('hashFile', () => {
  test('same content hashes the same', async () => {
    await write(A_DIR, 'x.txt', 'hello world');
    await write(B_DIR, 'y.txt', 'hello world');
    const h1 = await hashFile(path.join(A_DIR, 'x.txt'));
    const h2 = await hashFile(path.join(B_DIR, 'y.txt'));
    expect(h1).toBe(h2);
  });

  test('different content hashes differently', async () => {
    await write(A_DIR, 'x.txt', 'hello');
    await write(B_DIR, 'y.txt', 'world');
    const h1 = await hashFile(path.join(A_DIR, 'x.txt'));
    const h2 = await hashFile(path.join(B_DIR, 'y.txt'));
    expect(h1).not.toBe(h2);
  });
});

describe('scanTree', () => {
  test('skips junk files but keeps real ones', async () => {
    await write(A_DIR, 'real.txt', 'content');
    await write(A_DIR, '.DS_Store', 'junk');
    await write(A_DIR, '._real.txt', 'junk');
    await write(A_DIR, 'sub/thumbs.db', 'junk');
    await write(A_DIR, 'sub/nested.txt', 'nested content');

    const manifest = await scanTree(A_DIR);
    expect([...manifest.keys()].sort()).toEqual(['real.txt', 'sub/nested.txt']);
  });
});

describe('compareManifests', () => {
  test('identical trees have no differences', async () => {
    await write(A_DIR, 'file.txt', 'same');
    await write(B_DIR, 'file.txt', 'same');
    const a = await scanTree(A_DIR);
    const b = await scanTree(B_DIR);
    const cmp = compareManifests(a, b);
    expect(cmp.onlyInA).toEqual([]);
    expect(cmp.onlyInB).toEqual([]);
    expect(cmp.conflicts).toEqual([]);
    expect(cmp.identical).toEqual(['file.txt']);
    expect(isRedundant(cmp)).toBe(true);
  });

  test('detects files unique to each side', async () => {
    await write(A_DIR, 'shared.txt', 'same');
    await write(A_DIR, 'only-a.txt', 'a content');
    await write(B_DIR, 'shared.txt', 'same');
    await write(B_DIR, 'only-b.txt', 'b content');
    const a = await scanTree(A_DIR);
    const b = await scanTree(B_DIR);
    const cmp = compareManifests(a, b);
    expect(cmp.onlyInA).toEqual(['only-a.txt']);
    expect(cmp.onlyInB).toEqual(['only-b.txt']);
    expect(cmp.identical).toEqual(['shared.txt']);
    expect(isRedundant(cmp)).toBe(false);
  });

  test('same path with different content is a conflict, not a silent pick', async () => {
    await write(A_DIR, 'notes.txt', 'version one');
    await write(B_DIR, 'notes.txt', 'version two');
    const a = await scanTree(A_DIR);
    const b = await scanTree(B_DIR);
    const cmp = compareManifests(a, b);
    expect(cmp.conflicts).toEqual(['notes.txt']);
    expect(cmp.identical).toEqual([]);
    expect(isRedundant(cmp)).toBe(false);
  });

  test('A being a pure subset of B is redundant even though B has extra files', async () => {
    await write(A_DIR, 'shared.txt', 'same');
    await write(B_DIR, 'shared.txt', 'same');
    await write(B_DIR, 'extra.txt', 'more content');
    const a = await scanTree(A_DIR);
    const b = await scanTree(B_DIR);
    const cmp = compareManifests(a, b);
    expect(isRedundant(cmp)).toBe(true); // nothing in A is missing from B
    expect(cmp.onlyInB).toEqual(['extra.txt']);
  });
});

describe('formatComparisonLines', () => {
  test('reports redundancy verdict for a pure subset', async () => {
    await write(A_DIR, 'shared.txt', 'same');
    await write(B_DIR, 'shared.txt', 'same');
    await write(B_DIR, 'extra.txt', 'more content');
    const cmp = compareManifests(await scanTree(A_DIR), await scanTree(B_DIR));
    const lines = formatComparisonLines('A', 'B', cmp).join('\n');
    expect(lines).toContain('identical: 1');
    expect(lines).toContain('only in B: 1');
    expect(lines).toContain('extra.txt');
    expect(lines).toContain('A is a redundant subset of B -- safe to discard A.');
  });

  test('warns against discarding when A has unique content', async () => {
    await write(A_DIR, 'only-a.txt', 'a content');
    await write(B_DIR, 'only-b.txt', 'b content');
    const cmp = compareManifests(await scanTree(A_DIR), await scanTree(B_DIR));
    const lines = formatComparisonLines('A', 'B', cmp).join('\n');
    expect(lines).toContain('has content not present in');
    expect(lines).not.toContain('safe to discard');
  });

  test('surfaces conflicts explicitly', async () => {
    await write(A_DIR, 'notes.txt', 'version one');
    await write(B_DIR, 'notes.txt', 'version two');
    const cmp = compareManifests(await scanTree(A_DIR), await scanTree(B_DIR));
    const lines = formatComparisonLines('A', 'B', cmp).join('\n');
    expect(lines).toContain('conflicts (same path, different content): 1');
    expect(lines).toContain('notes.txt');
  });
});

describe('planMerge', () => {
  test('deduplicates identical files across sources without copying twice', async () => {
    await write(A_DIR, 'shared.txt', 'same content');
    await write(B_DIR, 'shared.txt', 'same content');
    const plan = await planMerge([A_DIR, B_DIR]);
    expect(plan.totalUniquePaths).toBe(1);
    expect(plan.duplicateCopiesSkipped).toBe(1);
    expect(plan.conflicts).toEqual([]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('copy');
  });

  test('keeps every version of a genuine conflict, not just one', async () => {
    await write(A_DIR, 'config.json', '{"env":"a"}');
    await write(B_DIR, 'config.json', '{"env":"b"}');
    const plan = await planMerge([A_DIR, B_DIR]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].relPath).toBe('config.json');
    const conflictActions = plan.actions.filter((a) => a.type === 'conflict-copy');
    expect(conflictActions).toHaveLength(2);
    const destNames = conflictActions.map((a) => a.destRelPath).sort();
    expect(destNames).toEqual([
      'config (CONFLICT-a).json',
      'config (CONFLICT-b).json',
    ]);
  });

  test('merges unique content from three sources with no overlap', async () => {
    await write(A_DIR, 'from-a.txt', 'a');
    await write(B_DIR, 'from-b.txt', 'b');
    await write(C_DIR, 'from-c.txt', 'c');
    const plan = await planMerge([A_DIR, B_DIR, C_DIR]);
    expect(plan.totalUniquePaths).toBe(3);
    expect(plan.duplicateCopiesSkipped).toBe(0);
    expect(plan.conflicts).toEqual([]);
  });
});

describe('executeMergePlan', () => {
  test('writes deduplicated and conflicting files to the destination', async () => {
    await write(A_DIR, 'shared.txt', 'same content');
    await write(B_DIR, 'shared.txt', 'same content');
    await write(A_DIR, 'unique-a.txt', 'only in a');
    await write(A_DIR, 'clash.txt', 'a version');
    await write(B_DIR, 'clash.txt', 'b version');

    const plan = await planMerge([A_DIR, B_DIR]);
    const result = await executeMergePlan(plan, DEST_DIR);

    expect(result.errors).toEqual([]);
    expect(result.copied).toBe(plan.actions.length);

    const shared = await fs.readFile(path.join(DEST_DIR, 'shared.txt'), 'utf-8');
    expect(shared).toBe('same content');

    const uniqueA = await fs.readFile(path.join(DEST_DIR, 'unique-a.txt'), 'utf-8');
    expect(uniqueA).toBe('only in a');

    const clashA = await fs.readFile(path.join(DEST_DIR, 'clash (CONFLICT-a).txt'), 'utf-8');
    const clashB = await fs.readFile(path.join(DEST_DIR, 'clash (CONFLICT-b).txt'), 'utf-8');
    expect(clashA).toBe('a version');
    expect(clashB).toBe('b version');
  });

  test('preserves source mtime on the merged copy', async () => {
    await write(A_DIR, 'file.txt', 'content');
    const srcPath = path.join(A_DIR, 'file.txt');
    const oldTime = new Date('2010-01-01T00:00:00Z');
    await fs.utimes(srcPath, oldTime, oldTime);

    const plan = await planMerge([A_DIR]);
    await executeMergePlan(plan, DEST_DIR);

    const stat = await fs.stat(path.join(DEST_DIR, 'file.txt'));
    expect(stat.mtime.getTime()).toBe(oldTime.getTime());
  });
});
