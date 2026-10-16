import * as path from 'path';
import blessed from 'neo-blessed';
import { createStatusBar, FILE_HINTS, TREE_HINTS } from '../tui/status-bar.js';
import type { StatusBar } from '../tui/status-bar.js';
import { createStatsPane } from '../tui/stats-pane.js';
import type { StatsPane } from '../tui/stats-pane.js';
import { createViewerPane } from '../tui/viewer-pane.js';
import type { ViewerPane } from '../tui/viewer-pane.js';
import { getCachedDirStats } from '../fs/dir-stats.js';
import { clampSelectedIndex, getVisibleEntries } from '../state/app-state.js';
import type { FileEntry } from '../fs/list.js';
import type { OperationResult } from '../fs/operations.js';
import { showConfirm } from '../tui/prompt.js';
import { createPanel } from './panel.js';
import type { Panel } from './panel.js';

// The shared chrome (status bar, stats pane, viewer) and the panels. refreshUI
// renders the active panel into the shared widgets.
export interface App {
  screen: blessed.Widgets.Screen;
  statusBar: StatusBar;
  statsPane: StatsPane;
  viewerPane: ViewerPane;
  panels: Panel[];
  activePanel(): Panel;
  refreshUI(): void;
  finishFileOperation(targets: FileEntry[], result: OperationResult, label: string): Promise<void>;
}

export async function createApp(
  screen: blessed.Widgets.Screen,
  startPath: string
): Promise<App> {
  // Widget creation order is unchanged from the old main(): status bar,
  // tree pane, file pane (inside createPanel), stats pane, viewer.
  const statusBar = createStatusBar(screen);
  const panel = await createPanel(screen, startPath);
  const panels: Panel[] = [panel];
  const activePanel = (): Panel => panels[0];

  const statsPane = createStatsPane(screen);

  // Viewer pane (created lazily on first use)
  const viewerPane = createViewerPane(screen, panel.state, () => {
    // On viewer exit: restore normal mode
    const p = activePanel();
    p.state.viewMode = 'normal';
    p.state.viewerState = null;
    refreshUI();
  });

  function refreshUI(): void {
    const p = activePanel();
    const { state, treeState, treePane, filePane } = p;
    if (state.viewMode === 'viewer') return;

    // Apply display mode to panes
    treePane.setDisplayMode(state.displayMode);
    filePane.setDisplayMode(state.displayMode);
    filePane.setListingMode(state.listingMode);

    // Stats pane: visible only in 'dir' mode
    if (state.displayMode === 'dir') {
      // Compute stats for the stats pane
      const allEntries = state.entries;
      const files = allEntries.filter((e) => !e.isDirectory);
      const totalFiles = files.length;
      const totalBytes = files.reduce((sum, e) => sum + e.size, 0);
      // "Matching" = same as total when filespec is active (already filtered)
      const matchingFiles = totalFiles;
      const matchingBytes = totalBytes;
      // Tagged stats
      const taggedEntries = files.filter((e) => state.taggedPaths.has(e.path));
      const taggedFiles = taggedEntries.length;
      const taggedBytes = taggedEntries.reduce((sum, e) => sum + e.size, 0);
      // Current dir stats
      const dirStats = getCachedDirStats(state.currentPath);
      const currentDirFiles = dirStats?.fileCount ?? files.length;

      statsPane.refresh({
        filespec: state.filespecFilter,
        diskStats: p.currentDiskStats,
        totalFiles,
        totalBytes,
        matchingFiles,
        matchingBytes,
        taggedFiles,
        taggedBytes,
        currentDirName: path.basename(state.currentPath) || state.currentPath,
        currentDirFiles,
      });
      statsPane.show();
    } else {
      statsPane.hide();
    }

    clampSelectedIndex(state);
    const displayEntries = getVisibleEntries(state);

    filePane.refresh(displayEntries, state.taggedPaths);
    filePane.setSelectedIndex(state.selectedIndex);
    treePane.refresh(treeState.flatNodes, state.currentPath);
    statusBar.updatePath(
      state.currentPath,
      displayEntries.length,
      state.taggedPaths.size,
      state.sortOrder,
      state.sortDirection,
      state.filespecFilter,
      p.diskInfo,
      state.listingMode,
      state.showTaggedOnly
    );
    const hints = state.focusPane === 'tree' ? TREE_HINTS : FILE_HINTS;
    statusBar.updateBottomHints(hints);

    // Update focus visuals
    filePane.setFocused(state.focusPane === 'files');
    treePane.setFocused(state.focusPane === 'tree');

    screen.render();
  }
  panel.refreshUI = refreshUI;

  // Shared tail for copy/move/delete: report failure, untag the operated-on
  // targets, and reload -- the only thing that differs between the three is
  // which fs op produced `result` and the label for its failure message.
  async function finishFileOperation(
    targets: FileEntry[],
    result: OperationResult,
    label: string
  ): Promise<void> {
    const p = activePanel();
    if (!result.success) {
      await showConfirm(screen, `${label} failed: ${result.error}`);
    }
    for (const t of targets) {
      p.state.taggedPaths.delete(t.path);
    }
    await p.loadDirectory(p.state.currentPath);
  }

  return {
    screen,
    statusBar,
    statsPane,
    viewerPane,
    panels,
    activePanel,
    refreshUI,
    finishFileOperation,
  };
}
