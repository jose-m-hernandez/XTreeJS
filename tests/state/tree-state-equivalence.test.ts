import { describe, expect, test, setDefaultTimeout } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  createTreeState,
  expandNode,
  flattenTree,
  type TreeNode,
} from '../../src/state/tree-state.js';

// createTreeState walks from the volume root, so a slow disk needs headroom.
setDefaultTimeout(30000);

/**
 * Pins the exact tree built over a fixture that holds every entry kind the
 * builder treats specially. Written against the pre-H1 code; the literal below
 * is that code's output and must not change when the builder is optimised.
 *
 * Known asymmetry, kept on purpose: expandNode follows symlinks (a symlinked
 * dir appears as a child), hasSubdirectories does not (a dir whose only
 * subdir is a symlink is not expandable).
 */
// Names chosen so that plain code-point sorting, case-insensitive sorting and
// the base-sensitivity collator all disagree, while no two names compare equal
// under `sensitivity: 'base'` (equal names would keep readdir order, which
// differs between APFS and Linux). All coexist on case-insensitive APFS.
const ORDER_NAMES = ['Ab', 'aa', 'éa', 'eb', 'item10', 'item2', '_z', 'zz', '-m', 'Zeta', 'alpha'];

async function buildFixture(): Promise<string> {
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'xtree-equiv-'));
  const mk = (...p: string[]) => fs.mkdir(path.join(root, ...p), { recursive: true });
  await mk('alpha', 'beta');
  await mk('alpha', 'gamma');
  await mk('plain');
  await mk('.hidden', 'inside');
  await mk('hiddenonly', '.sub');
  await mk('onlylink');
  await mk('locked');
  await mk('zeta', 'deep', 'deeper');
  for (const name of ORDER_NAMES) await mk('order', name);
  await fs.writeFile(path.join(root, 'file.txt'), 'x');
  await fs.writeFile(path.join(root, 'alpha', 'inner.txt'), 'x');
  await fs.symlink(path.join(root, 'alpha'), path.join(root, 'link-to-dir'));
  await fs.symlink(path.join(root, 'file.txt'), path.join(root, 'link-to-file'));
  await fs.symlink(path.join(root, 'nowhere'), path.join(root, 'dangling'));
  await fs.symlink(path.join(root, 'zeta'), path.join(root, 'onlylink', 'sub-link'));
  await fs.symlink(path.join(root, 'plain'), path.join(root, 'alpha', 'inner-link'));
  await fs.chmod(path.join(root, 'locked'), 0o000);
  return root;
}

function describeNodes(root: string, nodes: TreeNode[]): Array<[string, number, boolean | null, boolean, boolean]> {
  return nodes
    .filter((n) => n.path === root || n.path.startsWith(root + path.sep))
    .map((n) => [
      n.path === root ? '.' : path.relative(root, n.path),
      n.depth - nodes.find((m) => m.path === root)!.depth,
      n.path === root ? null : n.isLast, // the root's siblings in tmpdir vary
      n.hasSubdirs,
      n.expanded,
    ]);
}

const isRoot = process.getuid?.() === 0;

describe('tree builder equivalence', () => {
  test.skipIf(isRoot)('flattened tree over a mixed fixture is unchanged', async () => {
    // No two order/ names may compare equal under base sensitivity, or the
    // literal would depend on readdir order.
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
    for (let i = 0; i < ORDER_NAMES.length; i++) {
      for (let j = i + 1; j < ORDER_NAMES.length; j++) {
        expect(collator.compare(ORDER_NAMES[i], ORDER_NAMES[j])).not.toBe(0);
      }
    }
    const root = await buildFixture();
    try {
      const state = await createTreeState(root);
      const fixtureNode = state.flatNodes.find((n) => n.path === root)!;
      // Expand a few children by hand so the symlink handling inside
      // expandNode is pinned too (alpha holds a symlink to a dir).
      for (const name of ['alpha', 'link-to-dir', 'zeta', 'hiddenonly', 'onlylink', 'locked', 'order']) {
        const child = fixtureNode.children.find((c) => c.name === name);
        if (child) await expandNode(child);
      }
      const flat = flattenTree(state.root);
      expect(describeNodes(root, flat)).toEqual([
        [".", 0, null, true, true],
        ["alpha", 1, false, true, true],
        ["alpha/beta", 2, false, false, false],
        ["alpha/gamma", 2, false, false, false],
        ["alpha/inner-link", 2, true, false, false],
        ["hiddenonly", 1, false, true, true],
        ["link-to-dir", 1, false, true, true],
        ["link-to-dir/beta", 2, false, false, false],
        ["link-to-dir/gamma", 2, false, false, false],
        ["link-to-dir/inner-link", 2, true, false, false],
        ["locked", 1, false, false, false],
        ["onlylink", 1, false, false, false],
        ["order", 1, false, true, true],
        ["order/_z", 2, false, false, false],
        ["order/-m", 2, false, false, false],
        ["order/aa", 2, false, false, false],
        ["order/Ab", 2, false, false, false],
        ["order/alpha", 2, false, false, false],
        ["order/éa", 2, false, false, false],
        ["order/eb", 2, false, false, false],
        ["order/item10", 2, false, false, false],
        ["order/item2", 2, false, false, false],
        ["order/Zeta", 2, false, false, false],
        ["order/zz", 2, true, false, false],
        ["plain", 1, false, false, false],
        ["zeta", 1, true, true, true],
        ["zeta/deep", 2, true, true, false],
      ]);
    } finally {
      await fs.chmod(path.join(root, 'locked'), 0o755).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
