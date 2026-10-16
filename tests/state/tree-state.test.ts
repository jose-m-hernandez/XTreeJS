import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  createTreeNode,
  expandNode,
  collapseNode,
  flattenTree,
  createTreeState,
  refreshFlatNodes,
  deepDive,
  findNextSibling,
  findPrevSibling,
  expandTreeToPath,
} from '../../src/state/tree-state.js';

const TEST_DIR = '/tmp/claude/xtreejs-tree-test';

beforeEach(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(TEST_DIR, 'alpha', 'nested'), { recursive: true });
  await fs.mkdir(path.join(TEST_DIR, 'beta'), { recursive: true });
  await fs.mkdir(path.join(TEST_DIR, 'gamma'), { recursive: true });
  await fs.writeFile(path.join(TEST_DIR, 'file.txt'), 'hello');
  await fs.writeFile(path.join(TEST_DIR, 'alpha', 'inner.txt'), 'world');
});

afterEach(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe('createTreeNode', () => {
  test('creates node with correct properties', async () => {
    const node = await createTreeNode(TEST_DIR, 0);
    expect(node.path).toBe(TEST_DIR);
    expect(node.depth).toBe(0);
    expect(node.expanded).toBe(false);
    expect(node.hasSubdirs).toBe(true);
    expect(node.children).toEqual([]);
  });

  test('detects dirs with no subdirectories', async () => {
    const node = await createTreeNode(path.join(TEST_DIR, 'beta'), 1);
    expect(node.hasSubdirs).toBe(false);
  });

  test('detects dirs with subdirectories', async () => {
    const node = await createTreeNode(path.join(TEST_DIR, 'alpha'), 1);
    expect(node.hasSubdirs).toBe(true);
  });
});

describe('expandNode', () => {
  test('populates children for directory with subdirs', async () => {
    const node = await createTreeNode(TEST_DIR, 0);
    await expandNode(node);
    expect(node.expanded).toBe(true);
    expect(node.children.length).toBe(3); // alpha, beta, gamma
    expect(node.children.map((c) => c.name).sort()).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  test('sets correct depth on children', async () => {
    const node = await createTreeNode(TEST_DIR, 0);
    await expandNode(node);
    for (const child of node.children) {
      expect(child.depth).toBe(1);
    }
  });

  test('does nothing if already expanded', async () => {
    const node = await createTreeNode(TEST_DIR, 0);
    await expandNode(node);
    const childCount = node.children.length;
    await expandNode(node); // second call
    expect(node.children.length).toBe(childCount);
  });
});

describe('collapseNode', () => {
  test('clears children and marks collapsed', async () => {
    const node = await createTreeNode(TEST_DIR, 0);
    await expandNode(node);
    expect(node.expanded).toBe(true);
    collapseNode(node);
    expect(node.expanded).toBe(false);
    expect(node.children).toEqual([]);
  });
});

describe('flattenTree', () => {
  test('returns only root when collapsed', async () => {
    const node = await createTreeNode(TEST_DIR, 0);
    const flat = flattenTree(node);
    expect(flat.length).toBe(1);
    expect(flat[0].path).toBe(TEST_DIR);
  });

  test('returns root + children when expanded', async () => {
    const node = await createTreeNode(TEST_DIR, 0);
    await expandNode(node);
    const flat = flattenTree(node);
    expect(flat.length).toBe(4); // root + alpha + beta + gamma
  });

  test('includes nested expanded children', async () => {
    const node = await createTreeNode(TEST_DIR, 0);
    await expandNode(node);
    const alpha = node.children.find((c) => c.name === 'alpha')!;
    await expandNode(alpha);
    const flat = flattenTree(node);
    expect(flat.length).toBe(5); // root + alpha + nested + beta + gamma
  });
});

describe('createTreeState', () => {
  test('creates state with volume root and expands down to startPath', async () => {
    const state = await createTreeState(TEST_DIR);
    // Root should be the volume root, not the test dir
    expect(state.root.path).toBe('/');
    expect(state.root.expanded).toBe(true);
    // Should have expanded down to reach the test dir (may be resolved via symlinks)
    expect(state.flatNodes.length).toBeGreaterThan(1);
    const resolvedTestDir = await import('fs/promises').then((f) => f.realpath(TEST_DIR));
    const testNode = state.flatNodes.find((n) => n.path === resolvedTestDir);
    expect(testNode).toBeDefined();
  });
});

describe('refreshFlatNodes', () => {
  test('updates flatNodes after tree mutation', async () => {
    const state = await createTreeState(TEST_DIR);
    const initialCount = state.flatNodes.length;
    // Find the test dir node and expand one of its children
    const resolvedTestDir = await import('fs/promises').then((f) => f.realpath(TEST_DIR));
    const testNode = state.flatNodes.find((n) => n.path === resolvedTestDir);
    expect(testNode).toBeDefined();
    const alpha = testNode!.children.find((c) => c.name === 'alpha');
    if (alpha && alpha.hasSubdirs && !alpha.expanded) {
      await expandNode(alpha);
    }
    refreshFlatNodes(state);
    expect(state.flatNodes.length).toBeGreaterThanOrEqual(initialCount);
  });
});

describe('expandTreeToPath', () => {
  test('expands ancestors so a deeply nested, never-expanded path becomes selectable', async () => {
    const state = await createTreeState(TEST_DIR);
    const resolvedTestDir = await fs.realpath(TEST_DIR);
    const targetPath = path.join(resolvedTestDir, 'alpha', 'nested');

    // Collapse everything back to just the root, simulating a tree that
    // never expanded down this branch (e.g. after a jump far from anywhere
    // previously visited).
    collapseNode(state.root);
    refreshFlatNodes(state);
    expect(state.flatNodes.length).toBe(1);
    expect(state.flatNodes.find((n) => n.path === targetPath)).toBeUndefined();

    await expandTreeToPath(state, targetPath);
    refreshFlatNodes(state);

    expect(state.flatNodes.find((n) => n.path === targetPath)).toBeDefined();
  });

  test('is a no-op when targetPath is the tree root', async () => {
    const state = await createTreeState(TEST_DIR);
    collapseNode(state.root);
    refreshFlatNodes(state);
    await expandTreeToPath(state, state.root.path);
    expect(state.root.expanded).toBe(false);
  });

  test('does nothing for a path outside the tree root', async () => {
    // Build a tree rooted below the filesystem root (unlike the app's real
    // volume-rooted tree) so a sibling path genuinely falls outside it.
    const root = await createTreeNode(path.join(TEST_DIR, 'alpha'), 0, true);
    const state = { root, flatNodes: flattenTree(root), selectedIndex: 0 };
    await expandTreeToPath(state, path.join(TEST_DIR, 'beta'));
    expect(state.root.expanded).toBe(false);
  });
});

describe('deepDive', () => {
  test('follows single-child path to deepest node', async () => {
    // alpha has one subdir: nested (no further subdirs)
    const node = await createTreeNode(path.join(TEST_DIR, 'alpha'), 1);
    const result = await deepDive(node);
    expect(result.name).toBe('nested');
    expect(node.expanded).toBe(true);
  });

  test('returns same node if no subdirs', async () => {
    const node = await createTreeNode(path.join(TEST_DIR, 'beta'), 1);
    const result = await deepDive(node);
    expect(result.path).toBe(node.path);
  });
});

describe('findNextSibling', () => {
  test('finds next node at same depth', async () => {
    const state = await createTreeState(TEST_DIR);
    // flatNodes: [root, alpha, beta, gamma]
    const alphaIdx = state.flatNodes.findIndex((n) => n.name === 'alpha');
    const betaIdx = state.flatNodes.findIndex((n) => n.name === 'beta');
    expect(findNextSibling(state.flatNodes, alphaIdx)).toBe(betaIdx);
  });

  test('returns current index if no next sibling', async () => {
    const state = await createTreeState(TEST_DIR);
    const gammaIdx = state.flatNodes.findIndex((n) => n.name === 'gamma');
    expect(findNextSibling(state.flatNodes, gammaIdx)).toBe(gammaIdx);
  });
});

describe('findPrevSibling', () => {
  test('finds previous node at same depth', async () => {
    const state = await createTreeState(TEST_DIR);
    const betaIdx = state.flatNodes.findIndex((n) => n.name === 'beta');
    const alphaIdx = state.flatNodes.findIndex((n) => n.name === 'alpha');
    expect(findPrevSibling(state.flatNodes, betaIdx)).toBe(alphaIdx);
  });

  test('returns current index if no prev sibling', async () => {
    const state = await createTreeState(TEST_DIR);
    const alphaIdx = state.flatNodes.findIndex((n) => n.name === 'alpha');
    expect(findPrevSibling(state.flatNodes, alphaIdx)).toBe(alphaIdx);
  });
});
