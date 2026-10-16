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
import { createTreeState, selectTreePath } from '../state/tree-state.js';
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

// The directory lister is injectable so a test can control when each listing
// resolves; production always uses listDirectory.
export type Lister = typeof listDirectory;

export async function createPanel(
  screen: blessed.Widgets.Screen,
  startPath: string,
  lister: Lister = listDirectory
): Promise<Panel> {
  const state = createAppState(startPath);
  const treeState = await createTreeState(startPath);

  const treePane = createTreePane(screen);
  const filePane = createFilePane(screen);

  // Each listing takes a generation number; a result whose number is no longer
  // current was overtaken by a later load and must not touch the state.
  let loadGeneration = 0;

  // Lists state.currentPath into state.entries. Returns false, leaving the
  // state alone, when a later load started while this one was in flight.
  async function relist(): Promise<boolean> {
    const generation = ++loadGeneration;
    const entries = await lister(
      state.currentPath,
      state.sortOrder,
      state.sortDirection,
      state.filespecFilter
    );
    if (generation !== loadGeneration) return false;
    state.entries = entries;
    state.selectedIndex = 0;
    return true;
  }

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
      treePane.refresh(treeState.flatNodes, state.currentPath, treeState.selectedIndex);
      screen.render();
    },

    // Re-lists state.currentPath with the current sort/filespec and resets
    // the selection -- the common tail of loadDirectory and every handler
    // that changes sort order or the filespec filter without changing dir.
    async reloadEntries(): Promise<void> {
      await relist();
    },

    async loadDirectory(dirPath: string): Promise<void> {
      state.currentPath = dirPath;
      state.listingMode = 'normal';
      state.branchBasePath = null;
      if (!(await relist())) return; // a newer load took over; drop this one
      selectTreePath(treeState, dirPath);
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
      const generation = ++loadGeneration;
      const entries = await listDirectoryRecursive(
        basePath,
        state.sortOrder,
        state.sortDirection,
        state.filespecFilter
      );
      if (generation !== loadGeneration) return;
      state.entries = entries;
      state.selectedIndex = 0;
      p.refreshUI();
    },
  };
  return p;
}
