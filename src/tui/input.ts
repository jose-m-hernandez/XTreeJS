import * as path from 'path';
import blessed from 'neo-blessed';
import type { AppState } from '../state/app-state.js';
import {
  getSelectedEntry,
  toggleTag,
  tagAll,
  untagCurrent,
  untagAll,
  getVisibleEntries,
  advanceSelectionAfterTagChange,
} from '../state/app-state.js';
import type { TreeState } from '../state/tree-state.js';
import {
  expandNode,
  collapseNode,
  toggleNode,
  refreshFlatNodes,
} from '../state/tree-state.js';
import { getKeyRouter } from './key-router.js';
import { findBinding, type LocalAction } from './keymap.js';

export interface InputCallbacks {
  onNavigate(path: string): void | Promise<void>;
  onRefresh(): void | Promise<void>;
  onQuit(): void | Promise<void>;
  onCopy(): void | Promise<void>;
  onMove(): void | Promise<void>;
  onDelete(): void | Promise<void>;
  onPrune(): void | Promise<void>;
  onView(): void | Promise<void>;
  onTabSwitch(): void | Promise<void>;
  onTreeSelect(path: string): void | Promise<void>;
  onSort(): void | Promise<void>;
  onSortDirection(): void | Promise<void>;
  onFilespec(): void | Promise<void>;
  onToggleFilespec(): void | Promise<void>;
  onInvertTag(): void | Promise<void>;
  onSpeedNav(letter: string): void | Promise<void>;
  onRename(): void | Promise<void>;
  onMakeDir(): void | Promise<void>;
  onAttributes(): void | Promise<void>;
  onEditor(): void | Promise<void>;
  onDeepDive(): void | Promise<void>;
  onNextSibling(): void | Promise<void>;
  onTreeRoot(): void | Promise<void>;
  onDisplayCycle(): void | Promise<void>;
  onForceRefresh(): void | Promise<void>;
  onHelp(): void | Promise<void>;
  onQuickRef(): void | Promise<void>;
  onBranchMode(): void | Promise<void>;
  onShowallMode(): void | Promise<void>;
  onTagByFilespec(): void | Promise<void>;
  onUntagByFilespec(): void | Promise<void>;
  onTagAllGlobal(): void | Promise<void>;
  onUntagAllGlobal(): void | Promise<void>;
  onToggleTaggedOnly(): void | Promise<void>;
  onPatternRename(): void | Promise<void>;
  onDedupeCompare(): void | Promise<void>;
}

/**
 * Wires normal-mode key handling: Ctrl+C always quits, and every other key
 * goes through the keymap unless a modal layer on the key router takes it
 * first. `onError` receives a message when a callback rejects or throws.
 */
export function setupInput(
  screen: blessed.Widgets.Screen,
  state: AppState,
  treeState: TreeState,
  callbacks: InputCallbacks,
  onError?: (message: string) => void
): void {
  const router = getKeyRouter(screen);
  if (onError) router.setErrorHandler(onError);

  function selectedTreeNode() {
    return treeState.flatNodes[treeState.selectedIndex];
  }

  const local: Record<LocalAction, (key: blessed.Widgets.Events.IKeyEventArg) => void | Promise<void>> = {
    'cursor-up': () => {
      if (state.focusPane === 'files') {
        if (state.selectedIndex > 0) {
          state.selectedIndex--;
          return callbacks.onRefresh();
        }
      } else {
        if (treeState.selectedIndex > 0) {
          treeState.selectedIndex--;
          return callbacks.onRefresh();
        }
      }
    },

    'cursor-down': () => {
      if (state.focusPane === 'files') {
        if (state.selectedIndex < getVisibleEntries(state).length - 1) {
          state.selectedIndex++;
          return callbacks.onRefresh();
        }
      } else {
        if (treeState.selectedIndex < treeState.flatNodes.length - 1) {
          treeState.selectedIndex++;
          return callbacks.onRefresh();
        }
      }
    },

    enter: async () => {
      if (state.focusPane === 'files') {
        const entry = getSelectedEntry(state);
        if (entry?.isDirectory) {
          await callbacks.onNavigate(entry.path);
        } else if (entry) {
          // Non-directory: cycle display mode
          await callbacks.onDisplayCycle();
        }
      } else {
        // In tree: expand or navigate to selected dir
        const node = selectedTreeNode();
        if (node) {
          if (node.hasSubdirs && !node.expanded) {
            await expandNode(node);
            refreshFlatNodes(treeState);
          }
          await callbacks.onTreeSelect(node.path);
        }
      }
    },

    right: () => {
      if (state.focusPane === 'files') {
        const entry = getSelectedEntry(state);
        if (entry?.isDirectory) {
          return callbacks.onNavigate(entry.path);
        }
      } else {
        // In tree: deep-dive — expand and follow first child
        return callbacks.onDeepDive();
      }
    },

    left: () => {
      if (state.focusPane === 'files') {
        const parent = path.dirname(state.currentPath);
        if (parent !== state.currentPath) {
          return callbacks.onNavigate(parent);
        }
      } else {
        // In tree: macOS pattern — if expanded, collapse; if collapsed, jump to parent
        const idx = treeState.selectedIndex;
        const node = treeState.flatNodes[idx];
        if (node && node.expanded) {
          collapseNode(node);
          refreshFlatNodes(treeState);
          return callbacks.onRefresh();
        } else if (node && node.depth > 0) {
          // Jump to parent: scan backwards for first node at depth - 1
          for (let i = idx - 1; i >= 0; i--) {
            if (treeState.flatNodes[i].depth === node.depth - 1) {
              treeState.selectedIndex = i;
              return callbacks.onTreeSelect(treeState.flatNodes[i].path);
            }
          }
        }
      }
    },

    root: () => {
      if (state.listingMode !== 'normal') {
        // In branch/showall: jump to parent dir of highlighted file, exit special mode
        const entry = getSelectedEntry(state);
        if (entry) {
          const parentDir = path.dirname(entry.path);
          state.listingMode = 'normal';
          state.branchBasePath = null;
          return callbacks.onNavigate(parentDir);
        }
      }
      return callbacks.onNavigate('/');
    },

    home: () => {
      if (state.focusPane === 'files') {
        state.selectedIndex = 0;
        return callbacks.onRefresh();
      }
      return callbacks.onTreeRoot();
    },

    end: () => {
      state.selectedIndex = Math.max(0, getVisibleEntries(state).length - 1);
      return callbacks.onRefresh();
    },

    'page-up': () => {
      state.selectedIndex = Math.max(0, state.selectedIndex - 20);
      return callbacks.onRefresh();
    },

    'page-down': () => {
      state.selectedIndex = Math.min(
        Math.max(0, getVisibleEntries(state).length - 1),
        state.selectedIndex + 20
      );
      return callbacks.onRefresh();
    },

    'tag-toggle': () => {
      const entry = getSelectedEntry(state);
      if (entry && !entry.isDirectory) {
        toggleTag(state, entry.path);
        // Move down after tagging
        advanceSelectionAfterTagChange(state);
        return callbacks.onRefresh();
      }
    },

    'tag-all': () => {
      tagAll(state);
      return callbacks.onRefresh();
    },

    'untag-current': () => {
      const entry = getSelectedEntry(state);
      if (entry) {
        untagCurrent(state, entry.path);
        advanceSelectionAfterTagChange(state);
        return callbacks.onRefresh();
      }
    },

    'untag-all': () => {
      untagAll(state);
      return callbacks.onRefresh();
    },

    'tree-expand': async () => {
      const node = selectedTreeNode();
      if (node && !node.expanded && node.hasSubdirs) {
        await expandNode(node);
        refreshFlatNodes(treeState);
        await callbacks.onRefresh();
      }
    },

    'tree-collapse': () => {
      const node = selectedTreeNode();
      if (node && node.expanded) {
        collapseNode(node);
        refreshFlatNodes(treeState);
        return callbacks.onRefresh();
      }
    },

    'tree-toggle': async () => {
      const node = selectedTreeNode();
      if (!node) return;

      // Capture state before toggling: collapse is synchronous, expand is not
      // (it awaits a readdir). Checking node.expanded after the call can't
      // distinguish "just collapsed" from "expand still in flight".
      const wasExpanded = node.expanded;
      const result = toggleNode(node);
      if (!wasExpanded) await result;
      refreshFlatNodes(treeState);
      await callbacks.onRefresh();
    },

    'speed-nav': (key) => {
      return callbacks.onSpeedNav(key.full.slice(2).toUpperCase());
    },
  };

  // Ctrl+C quits from anywhere, modals included.
  router.setGlobal((_ch, key) => {
    if (key.full !== 'C-c') return false;
    router.run(() => callbacks.onQuit());
    return true;
  });

  router.setBase((_ch, key) => {
    // The viewer is marked open a moment before its layer is pushed.
    if (state.viewMode !== 'normal') return;
    const binding = findBinding(key.full, state.focusPane);
    if (!binding) return;
    const action = binding.action;
    if (action in local) return local[action as LocalAction](key);
    return (callbacks[action as keyof InputCallbacks] as () => void | Promise<void>)();
  });
}
