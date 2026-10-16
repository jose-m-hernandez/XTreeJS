import * as path from 'path';
import * as fs from 'fs/promises';
import { hasSubdirectories } from '../fs/list.js';

export interface TreeNode {
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
  hasSubdirs: boolean;
  children: TreeNode[];
  isLast: boolean;
}

export interface TreeState {
  root: TreeNode;
  flatNodes: TreeNode[];
  /** Index into flatNodes of the tree cursor. Moves only through this field. */
  selectedIndex: number;
}

export async function createTreeNode(
  dirPath: string,
  depth: number,
  isLast: boolean = false
): Promise<TreeNode> {
  const hasSubs = await hasSubdirectories(dirPath);
  return {
    path: dirPath,
    name: path.basename(dirPath) || dirPath,
    depth,
    expanded: false,
    hasSubdirs: hasSubs,
    children: [],
    isLast,
  };
}

export async function expandNode(node: TreeNode): Promise<void> {
  if (!node.hasSubdirs || node.expanded) return;

  try {
    const entries = await fs.readdir(node.path);
    const dirs: string[] = [];

    for (const name of entries) {
      if (name.startsWith('.')) continue; // skip hidden by default in tree
      const fullPath = path.join(node.path, name);
      try {
        const stat = await fs.stat(fullPath); // stat follows symlinks so symlinked dirs appear
        if (stat.isDirectory()) {
          dirs.push(fullPath);
        }
      } catch {
        continue;
      }
    }

    dirs.sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), undefined, {
        sensitivity: 'base',
      })
    );

    node.children = [];
    for (let i = 0; i < dirs.length; i++) {
      const child = await createTreeNode(
        dirs[i],
        node.depth + 1,
        i === dirs.length - 1
      );
      node.children.push(child);
    }
    node.expanded = true;
  } catch {
    // Can't read directory
  }
}

export function collapseNode(node: TreeNode): void {
  node.expanded = false;
  node.children = [];
}

export function toggleNode(node: TreeNode): Promise<void> | void {
  if (node.expanded) {
    collapseNode(node);
  } else {
    return expandNode(node);
  }
}

export function flattenTree(node: TreeNode): TreeNode[] {
  const result: TreeNode[] = [node];
  if (node.expanded) {
    for (const child of node.children) {
      result.push(...flattenTree(child));
    }
  }
  return result;
}

export async function createTreeState(startPath: string): Promise<TreeState> {
  // Resolve symlinks so the path matches real filesystem entries
  let resolvedPath: string;
  try {
    resolvedPath = await fs.realpath(startPath);
  } catch {
    resolvedPath = startPath;
  }

  // Root the tree at the volume root, then expand down to startPath
  const volumeRoot = path.parse(resolvedPath).root; // '/' on macOS/Linux
  const root = await createTreeNode(volumeRoot, 0, true);
  root.expanded = false;
  await expandNode(root);
  root.expanded = true;

  // Auto-expand each segment of startPath so the user can see their launch dir
  const segments = path.relative(volumeRoot, resolvedPath).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    const child = current.children.find((c) => c.name === segment);
    if (!child) break;
    if (child.hasSubdirs && !child.expanded) {
      await expandNode(child);
    }
    current = child;
  }
  // Expand the final target dir too if it has subdirs
  if (current.hasSubdirs && !current.expanded) {
    await expandNode(current);
  }

  const flatNodes = flattenTree(root);
  const startIndex = flatNodes.findIndex((n) => n.path === resolvedPath);
  return {
    root,
    flatNodes,
    selectedIndex: Math.max(0, startIndex),
  };
}

/**
 * Moves the tree cursor onto the node for `targetPath`, if the flattened tree
 * has one; otherwise the cursor stays where it is. Returns whether it moved.
 */
export function selectTreePath(state: TreeState, targetPath: string): boolean {
  const idx = state.flatNodes.findIndex((n) => n.path === targetPath);
  if (idx < 0) return false;
  state.selectedIndex = idx;
  return true;
}

export function refreshFlatNodes(state: TreeState): void {
  state.flatNodes = flattenTree(state.root);
}

/**
 * Expands every ancestor directory between the tree root and `targetPath`
 * so a node for `targetPath` exists in the flattened tree and can be
 * selected/highlighted there.
 *
 * Without this, jumping straight to a path whose ancestors were never
 * individually expanded — e.g. exiting branch/showall mode via `\`, which
 * can land on a directory several levels below anything the tree has ever
 * expanded — leaves the tree pane's selection on whatever node it last had:
 * refreshFlatNodes()/TreePane.refresh() can only select a node that's
 * already present in flatNodes, and this is what puts it there.
 */
export async function expandTreeToPath(
  state: TreeState,
  targetPath: string
): Promise<void> {
  const root = state.root;
  if (targetPath === root.path) return;

  const relative = path.relative(root.path, targetPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return; // targetPath isn't under the tree's root — nothing to expand
  }

  if (root.hasSubdirs && !root.expanded) {
    await expandNode(root);
  }

  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const child = current.children.find((c) => c.name === segment);
    if (!child) return; // tree doesn't have this segment; nothing more to expand
    if (child.hasSubdirs && !child.expanded) {
      await expandNode(child);
    }
    current = child;
  }
}

export async function deepDive(node: TreeNode): Promise<TreeNode> {
  if (!node.hasSubdirs) return node;
  if (!node.expanded) {
    await expandNode(node);
  }
  // Follow first child path as long as there's exactly one subdir child
  let current = node;
  while (current.expanded && current.children.length === 1) {
    const child = current.children[0];
    if (!child.hasSubdirs) return child;
    await expandNode(child);
    current = child;
  }
  // If multiple children or leaf, return the deepest we reached
  if (current.children.length > 0) {
    return current.children[0];
  }
  return current;
}

export function findNextSibling(
  flatNodes: TreeNode[],
  currentIndex: number
): number {
  if (currentIndex < 0 || currentIndex >= flatNodes.length) return currentIndex;
  const currentDepth = flatNodes[currentIndex].depth;
  for (let i = currentIndex + 1; i < flatNodes.length; i++) {
    if (flatNodes[i].depth === currentDepth) return i;
    if (flatNodes[i].depth < currentDepth) break; // went up — no more siblings
  }
  return currentIndex; // no sibling found
}

export function findPrevSibling(
  flatNodes: TreeNode[],
  currentIndex: number
): number {
  if (currentIndex < 0 || currentIndex >= flatNodes.length) return currentIndex;
  const currentDepth = flatNodes[currentIndex].depth;
  for (let i = currentIndex - 1; i >= 0; i--) {
    if (flatNodes[i].depth === currentDepth) return i;
    if (flatNodes[i].depth < currentDepth) break; // went up — no more siblings
  }
  return currentIndex; // no sibling found
}
