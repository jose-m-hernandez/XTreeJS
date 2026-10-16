import blessed from 'neo-blessed';
import { createTreePane } from '../tui/tree-pane.js';
import type { TreePane } from '../tui/tree-pane.js';
import { createFilePane } from '../tui/file-pane.js';
import type { FilePane } from '../tui/file-pane.js';
import type { DiskStats } from '../fs/disk-stats.js';
import { getDiskStats } from '../fs/disk-stats.js';
import { computeStatsForPaths } from '../fs/dir-stats.js';
import { createAppState } from '../state/app-state.js';
import type { AppState } from '../state/app-state.js';
import { createTreeState } from '../state/tree-state.js';
import type { TreeState } from '../state/tree-state.js';
import { listDirectory, listDirectoryRecursive } from '../fs/list.js';

// One browsing panel: its state, its tree and file widgets, and the loaders
// that move its state to a directory. The shared chrome (status bar, stats
// pane, viewer) and refreshUI belong to the App, which sets `refreshUI` here.
export interface Panel {
  state: AppState;
  treeState: TreeState;
  treePane: TreePane;
  filePane: FilePane;
  diskInfo: string;
  currentDiskStats: DiskStats | null;
  refreshUI: () => void;
  updateDiskInfo(dirPath: string): Promise<void>;
  computeTreeStats(): Promise<void>;
  reloadEntries(): Promise<void>;
  loadDirectory(dirPath: string): Promise<void>;
  toggleRecursiveMode(mode: 'branch' | 'showall', basePath: string): Promise<void>;
}

export async function createPanel(
  screen: blessed.Widgets.Screen,
  startPath: string
): Promise<Panel> {
  const state = createAppState(startPath);
  const treeState = await createTreeState(startPath);

  const treePane = createTreePane(screen);
  const filePane = createFilePane(screen);

  const p: Panel = {
    state,
    treeState,
    treePane,
    filePane,
    diskInfo: '',
    currentDiskStats: null,
    refreshUI: () => {},

    async updateDiskInfo(dirPath: string): Promise<void> {
      try {
        const stats = await getDiskStats(dirPath);
        p.currentDiskStats = stats;
        p.diskInfo = `Avail: ${stats.available}`;
      } catch {
        p.currentDiskStats = null;
        p.diskInfo = '';
      }
    },

    async computeTreeStats(): Promise<void> {
      const paths = treeState.flatNodes.map((n) => n.path);
      await computeStatsForPaths(paths);
      // Re-render tree to show newly computed stats
      treePane.refresh(treeState.flatNodes, state.currentPath);
      screen.render();
    },

    // Re-lists state.currentPath with the current sort/filespec and resets
    // the selection -- the common tail of loadDirectory and every handler
    // that changes sort order or the filespec filter without changing dir.
    async reloadEntries(): Promise<void> {
      state.entries = await listDirectory(
        state.currentPath,
        state.sortOrder,
        state.sortDirection,
        state.filespecFilter
      );
      state.selectedIndex = 0;
    },

    async loadDirectory(dirPath: string): Promise<void> {
      state.currentPath = dirPath;
      state.listingMode = 'normal';
      state.branchBasePath = null;
      await p.reloadEntries();
      p.updateDiskInfo(dirPath); // fire and forget, don't block
      p.refreshUI();
    },

    // Shared toggle for branch/showall: both recursively list `basePath` and
    // switch back to a normal listing of the current dir if already active.
    async toggleRecursiveMode(
      mode: 'branch' | 'showall',
      basePath: string
    ): Promise<void> {
      if (state.listingMode === mode) {
        await p.loadDirectory(state.currentPath);
        return;
      }
      state.listingMode = mode;
      state.branchBasePath = basePath;
      state.entries = await listDirectoryRecursive(
        basePath,
        state.sortOrder,
        state.sortDirection,
        state.filespecFilter
      );
      state.selectedIndex = 0;
      p.refreshUI();
    },
  };
  return p;
}
