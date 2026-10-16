#!/usr/bin/env bun
import * as path from 'path';
import * as fs from 'fs/promises';
import { createScreen } from './tui/screen.js';
import { createTreePane } from './tui/tree-pane.js';
import { createFilePane } from './tui/file-pane.js';
import { createStatusBar, FILE_HINTS, TREE_HINTS } from './tui/status-bar.js';
import { createStatsPane } from './tui/stats-pane.js';
import type { DiskStats } from './fs/disk-stats.js';
import { getCachedDirStats } from './fs/dir-stats.js';
import { createViewerPane } from './tui/viewer-pane.js';
import {
  createAppState,
  getSelectedEntry,
  getOperationTargets,
  invertTags,
  getVisibleEntries,
  clampSelectedIndex,
  advanceSelectionAfterTagChange,
} from './state/app-state.js';
import type { SortOrder } from './state/app-state.js';
import {
  createTreeState, expandNode, refreshFlatNodes, expandTreeToPath,
  deepDive, findNextSibling,
} from './state/tree-state.js';
import { detectTools } from './fs/detect-tools.js';
import { listDirectory, listDirectoryRecursive, listAllFilesRecursive, matchFilespec } from './fs/list.js';
import type { FileEntry } from './fs/list.js';
import { getDiskStats } from './fs/disk-stats.js';
import { computeStatsForPaths, invalidateDirStats } from './fs/dir-stats.js';
import type { DisplayMode } from './state/app-state.js';
import { viewFile } from './fs/view.js';
import {
  copyFiles, moveFiles, deleteFiles, pruneDirectory,
  renameFile, makeDirectory, getFileAttributes, setFilePermissions, openInEditor,
  patternRename,
} from './fs/operations.js';
import type { OperationResult } from './fs/operations.js';
import { setupInput } from './tui/input.js';
import { showPrompt, showConfirm, showAttributes } from './tui/prompt.js';
import { showHelp, showQuickRef } from './tui/help-pane.js';
import { showTextReport, showBusyMessage } from './tui/dedupe-pane.js';
import { scanTree, compareManifests, formatComparisonLines } from './fs/dedupe.js';
import { Defaults } from './config/defaults.js';
import { runDedupeCommand } from './cli/dedupe-cli.js';

async function main() {
  // Non-interactive subcommands bypass the TUI entirely.
  const args = process.argv.slice(2);
  if (args[0] === 'dedupe') {
    const code = await runDedupeCommand(args.slice(1));
    process.exit(code);
  }

  // Detect available tools first
  await detectTools();

  const startPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : Defaults.startPath;

  const screen = createScreen();
  const state = createAppState(startPath);
  const treeState = await createTreeState(startPath);

  const statusBar = createStatusBar(screen);
  const treePane = createTreePane(screen);
  const filePane = createFilePane(screen);

  const statsPane = createStatsPane(screen);

  // Viewer pane (created lazily on first use)
  const viewerPane = createViewerPane(screen, state, () => {
    // On viewer exit: restore normal mode
    state.viewMode = 'normal';
    state.viewerState = null;
    refreshUI();
  });

  let diskInfo = '';
  let currentDiskStats: DiskStats | null = null;

  async function updateDiskInfo(dirPath: string): Promise<void> {
    try {
      const stats = await getDiskStats(dirPath);
      currentDiskStats = stats;
      diskInfo = `Avail: ${stats.available}`;
    } catch {
      currentDiskStats = null;
      diskInfo = '';
    }
  }

  async function computeTreeStats(): Promise<void> {
    const paths = treeState.flatNodes.map((n) => n.path);
    await computeStatsForPaths(paths);
    // Re-render tree to show newly computed stats
    treePane.refresh(treeState.flatNodes, state.currentPath);
    screen.render();
  }

  // Re-lists state.currentPath with the current sort/filespec and resets
  // the selection -- the common tail of loadDirectory and every handler
  // that changes sort order or the filespec filter without changing dir.
  async function reloadEntries(): Promise<void> {
    state.entries = await listDirectory(
      state.currentPath,
      state.sortOrder,
      state.sortDirection,
      state.filespecFilter
    );
    state.selectedIndex = 0;
  }

  async function loadDirectory(dirPath: string): Promise<void> {
    state.currentPath = dirPath;
    state.listingMode = 'normal';
    state.branchBasePath = null;
    await reloadEntries();
    updateDiskInfo(dirPath); // fire and forget, don't block
    refreshUI();
  }

  function refreshUI(): void {
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
        diskStats: currentDiskStats,
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
      diskInfo,
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

  // Shared tail for copy/move/delete: report failure, untag the operated-on
  // targets, and reload -- the only thing that differs between the three is
  // which fs op produced `result` and the label for its failure message.
  async function finishFileOperation(
    targets: FileEntry[],
    result: OperationResult,
    label: string
  ): Promise<void> {
    if (!result.success) {
      await showConfirm(screen, `${label} failed: ${result.error}`);
    }
    for (const t of targets) {
      state.taggedPaths.delete(t.path);
    }
    await loadDirectory(state.currentPath);
  }

  // Shared toggle for branch/showall: both recursively list `basePath` and
  // switch back to a normal listing of the current dir if already active.
  async function toggleRecursiveMode(
    mode: 'branch' | 'showall',
    basePath: string
  ): Promise<void> {
    if (state.listingMode === mode) {
      await loadDirectory(state.currentPath);
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
    refreshUI();
  }

  // Set up input handling
  setupInput(screen, state, treeState, treePane, {
    onNavigate: async (navPath: string) => {
      await loadDirectory(navPath);
      // Expand every ancestor down to navPath so the tree has a node for it
      // to select — a shallow "is it already a node?" check missed paths
      // whose ancestors were never individually expanded (e.g. jumping out
      // of branch/showall mode via `\` onto a deeply nested directory).
      await expandTreeToPath(treeState, navPath);
      refreshFlatNodes(treeState);
      refreshUI();
      computeTreeStats().catch(() => {}); // fire and forget
    },

    onRefresh: () => {
      refreshUI();
    },

    onQuit: () => {
      screen.destroy();
      process.exit(0);
    },

    onCopy: async () => {
      const targets = getOperationTargets(state);
      if (targets.length === 0) return;

      const dest = await showPrompt(
        screen,
        `Copy ${targets.length} item(s) to:`,
        state.currentPath,
        'copy-dest'
      );
      if (!dest) {
        refreshUI();
        return;
      }

      const result = await copyFiles(
        targets.map((t) => t.path),
        dest
      );
      await finishFileOperation(targets, result, 'Copy');
    },

    onMove: async () => {
      const targets = getOperationTargets(state);
      if (targets.length === 0) return;

      const dest = await showPrompt(
        screen,
        `Move ${targets.length} item(s) to:`,
        state.currentPath,
        'move-dest'
      );
      if (!dest) {
        refreshUI();
        return;
      }

      const result = await moveFiles(
        targets.map((t) => t.path),
        dest
      );
      await finishFileOperation(targets, result, 'Move');
    },

    onDelete: async () => {
      const targets = getOperationTargets(state);
      if (targets.length === 0) return;

      const names = targets.map((t) => t.name).join(', ');
      const confirmed = await showConfirm(
        screen,
        `Delete ${targets.length} item(s)? (${names})`
      );
      if (!confirmed) {
        refreshUI();
        return;
      }

      const result = await deleteFiles(targets.map((t) => t.path));
      await finishFileOperation(targets, result, 'Delete');
    },

    onPrune: async () => {
      const entry = getSelectedEntry(state);
      if (!entry?.isDirectory) return;

      const confirmed = await showConfirm(
        screen,
        `PRUNE entire directory tree: ${entry.name}? This cannot be undone easily!`
      );
      if (!confirmed) {
        refreshUI();
        return;
      }

      // Double confirmation for prune
      const reallyConfirmed = await showConfirm(
        screen,
        `Are you REALLY sure? All contents of ${entry.name} will be removed.`
      );
      if (!reallyConfirmed) {
        refreshUI();
        return;
      }

      const result = await pruneDirectory(entry.path);
      if (!result.success) {
        await showConfirm(screen, `Prune failed: ${result.error}`);
      }
      await loadDirectory(state.currentPath);
    },

    onView: async () => {
      const entry = getSelectedEntry(state);
      if (!entry || entry.isDirectory) return;

      state.viewMode = 'viewer';

      const cols = (screen.width as number) || 80;
      const rows = (screen.height as number) || 24;
      const result = await viewFile(entry.path, cols, rows);
      state.viewerState = {
        filePath: entry.path,
        lines: result.lines,
        scrollPos: 0,
        totalLines: result.totalLines,
        viewerMode: 'text',
        searchQuery: '',
        searchMatches: [],
        currentMatch: -1,
        wordWrap: false,
        tabSize: 4,
        followMode: false,
        gatherStart: null,
        gatherEnd: null,
      };

      viewerPane.show(result.lines, entry.path);
    },

    onTabSwitch: () => {
      state.focusPane = state.focusPane === 'files' ? 'tree' : 'files';
      refreshUI();

      if (state.focusPane === 'tree') {
        treePane.widget.focus();
      } else {
        filePane.widget.focus();
      }
    },

    onTreeSelect: async (treePath: string) => {
      await loadDirectory(treePath);
      computeTreeStats().catch(() => {}); // fire and forget
    },

    onSort: async () => {
      const order: SortOrder[] = ['name', 'ext', 'date', 'size', 'unsorted'];
      const idx = order.indexOf(state.sortOrder);
      state.sortOrder = order[(idx + 1) % order.length];
      await reloadEntries();
      refreshUI();
    },

    onSortDirection: async () => {
      state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
      await reloadEntries();
      refreshUI();
    },

    onFilespec: async () => {
      const spec = await showPrompt(
        screen,
        'Filespec filter (e.g. *.ts *.js):',
        state.filespecFilter,
        'filespec'
      );
      if (spec === null) {
        refreshUI();
        return;
      }
      // Store previous in history
      if (state.filespecFilter !== spec) {
        state.filespecHistory.unshift(state.filespecFilter);
        if (state.filespecHistory.length > 2) state.filespecHistory.length = 2;
      }
      state.filespecFilter = spec || '*';
      await reloadEntries();
      refreshUI();
    },

    onToggleFilespec: async () => {
      if (state.filespecHistory.length > 0) {
        const prev = state.filespecHistory[0];
        state.filespecHistory[0] = state.filespecFilter;
        state.filespecFilter = prev;
        await reloadEntries();
        refreshUI();
      }
    },

    onInvertTag: () => {
      const entry = getSelectedEntry(state);
      if (entry && !entry.isDirectory) {
        if (state.taggedPaths.has(entry.path)) {
          state.taggedPaths.delete(entry.path);
        } else {
          state.taggedPaths.add(entry.path);
        }
        advanceSelectionAfterTagChange(state);
        refreshUI();
      }
    },

    onInvertAllTags: () => {
      invertTags(state);
      refreshUI();
    },

    onSpeedNav: (letter: string) => {
      // Find next entry starting with letter, wrapping around
      const visibleEntries = getVisibleEntries(state);
      const start = state.selectedIndex + 1;
      for (let i = 0; i < visibleEntries.length; i++) {
        const idx = (start + i) % visibleEntries.length;
        if (visibleEntries[idx].name.toUpperCase().startsWith(letter)) {
          state.selectedIndex = idx;
          refreshUI();
          return;
        }
      }
    },

    onRename: async () => {
      const entry = getSelectedEntry(state);
      if (!entry) return;
      const newName = await showPrompt(screen, `Rename ${entry.name} to:`, entry.name, 'rename');
      if (!newName || newName === entry.name) {
        refreshUI();
        return;
      }
      const result = await renameFile(entry.path, newName);
      if (!result.success) {
        await showConfirm(screen, `Rename failed: ${result.error}`);
      }
      await loadDirectory(state.currentPath);
    },

    onMakeDir: async () => {
      const name = await showPrompt(screen, 'New directory name:', '', 'mkdir');
      if (!name) {
        refreshUI();
        return;
      }
      const result = await makeDirectory(state.currentPath, name);
      if (!result.success) {
        await showConfirm(screen, `Mkdir failed: ${result.error}`);
      }
      // Refresh tree and file list
      invalidateDirStats(state.currentPath);
      const node = treeState.flatNodes.find((n) => n.path === state.currentPath);
      if (node) {
        if (node.expanded) {
          // Re-expand to pick up the new dir
          node.expanded = false;
          node.children = [];
          await expandNode(node);
          refreshFlatNodes(treeState);
        }
      }
      await loadDirectory(state.currentPath);
    },

    onAttributes: async () => {
      const entry = getSelectedEntry(state);
      if (!entry) return;
      try {
        const attrs = await getFileAttributes(entry.path);
        const action = await showAttributes(screen, entry.name, attrs);
        if (action === 'chmod') {
          const modeStr = await showPrompt(screen, 'New permissions (octal, e.g. 755):', attrs.permissions, 'chmod');
          if (modeStr) {
            const mode = parseInt(modeStr, 8);
            if (!isNaN(mode)) {
              const result = await setFilePermissions(entry.path, mode);
              if (!result.success) {
                await showConfirm(screen, `chmod failed: ${result.error}`);
              }
            }
          }
        }
      } catch (err: any) {
        await showConfirm(screen, `Error: ${err.message}`);
      }
      refreshUI();
    },

    onEditor: async () => {
      const entry = getSelectedEntry(state);
      if (!entry || entry.isDirectory) return;
      try {
        // Suspend the TUI while the external editor takes over the terminal.
        (screen as any).leave?.();
        await openInEditor(entry.path);
      } catch {
        // Editor may fail
      } finally {
        // Resume the TUI and keep the app running.
        (screen as any).enter?.();
        refreshUI();
        if (state.focusPane === 'tree') {
          treePane.widget.focus();
        } else {
          filePane.widget.focus();
        }
      }
    },

    onDeepDive: async () => {
      const idx = treePane.getSelectedIndex();
      const node = treeState.flatNodes[idx];
      if (!node) return;
      const target = await deepDive(node);
      refreshFlatNodes(treeState);
      await loadDirectory(target.path);
      // Select the target node in the tree
      const newIdx = treeState.flatNodes.findIndex((n) => n.path === target.path);
      if (newIdx >= 0) {
        treePane.widget.select(newIdx);
      }
      refreshUI();
      computeTreeStats().catch(() => {}); // fire and forget
    },

    onNextSibling: () => {
      const idx = treePane.getSelectedIndex();
      const nextIdx = findNextSibling(treeState.flatNodes, idx);
      if (nextIdx !== idx) {
        treePane.widget.select(nextIdx);
        const node = treeState.flatNodes[nextIdx];
        if (node) {
          loadDirectory(node.path);
        }
      }
    },

    onPrevSibling: () => {
      // Currently unused but available for future binding
    },

    onTreeRoot: async () => {
      treePane.widget.select(0);
      const root = treeState.flatNodes[0];
      if (root) {
        await loadDirectory(root.path);
      }
    },

    onDisplayCycle: () => {
      const modes: DisplayMode[] = ['dir', 'small', 'expanded'];
      const idx = modes.indexOf(state.displayMode);
      state.displayMode = modes[(idx + 1) % modes.length];
      // If entering dir mode, switch focus to tree
      if (state.displayMode === 'dir') {
        state.focusPane = 'tree';
        treePane.widget.focus();
      }
      // If entering expanded mode, switch focus to files
      if (state.displayMode === 'expanded') {
        state.focusPane = 'files';
        filePane.widget.focus();
      }
      refreshUI();
    },

    onForceRefresh: async () => {
      // Invalidate stats for current dir so they get recomputed
      invalidateDirStats(state.currentPath);
      await loadDirectory(state.currentPath);
      await updateDiskInfo(state.currentPath);
      refreshUI();
      computeTreeStats().catch(() => {}); // fire and forget
    },

    onHelp: async () => {
      const context = state.focusPane === 'tree' ? 'tree' : 'files';
      await showHelp(screen, context);
      refreshUI();
    },

    onQuickRef: async () => {
      await showQuickRef(screen);
      refreshUI();
    },

    onBranchMode: async () => {
      await toggleRecursiveMode('branch', state.currentPath);
    },

    onShowallMode: async () => {
      await toggleRecursiveMode('showall', treeState.root.path);
    },

    onTagByFilespec: async () => {
      const pattern = await showPrompt(screen, 'Tag files matching:', '*', 'tag-filespec');
      if (!pattern) {
        refreshUI();
        return;
      }
      for (const entry of state.entries) {
        if (!entry.isDirectory && matchFilespec(entry.name, pattern)) {
          state.taggedPaths.add(entry.path);
        }
      }
      refreshUI();
    },

    onUntagByFilespec: async () => {
      const pattern = await showPrompt(screen, 'Untag files matching:', '*', 'tag-filespec');
      if (!pattern) {
        refreshUI();
        return;
      }
      for (const entry of state.entries) {
        if (!entry.isDirectory && matchFilespec(entry.name, pattern)) {
          state.taggedPaths.delete(entry.path);
        }
      }
      refreshUI();
    },

    onTagAllGlobal: async () => {
      const allFiles = await listAllFilesRecursive(treeState.root.path);
      for (const fp of allFiles) {
        state.taggedPaths.add(fp);
      }
      refreshUI();
    },

    onUntagAllGlobal: () => {
      state.taggedPaths.clear();
      refreshUI();
    },

    onToggleTaggedOnly: () => {
      state.showTaggedOnly = !state.showTaggedOnly;
      clampSelectedIndex(state);
      refreshUI();
    },

    onPatternRename: async () => {
      if (state.taggedPaths.size === 0) {
        await showConfirm(screen, 'No tagged files to rename.');
        refreshUI();
        return;
      }
      const fromPattern = await showPrompt(screen, 'Rename FROM pattern (e.g. *.txt):', '', 'pattern-rename');
      if (!fromPattern) {
        refreshUI();
        return;
      }
      const toPattern = await showPrompt(screen, 'Rename TO pattern (e.g. *.md):', '', 'pattern-rename');
      if (!toPattern) {
        refreshUI();
        return;
      }
      const taggedFiles = [...state.taggedPaths];
      const confirmed = await showConfirm(
        screen,
        `Rename ${taggedFiles.length} tagged file(s): ${fromPattern} → ${toPattern}?`
      );
      if (!confirmed) {
        refreshUI();
        return;
      }
      const result = await patternRename(taggedFiles, fromPattern, toPattern);
      if (!result.success) {
        await showConfirm(screen, `Rename errors: ${result.errors.join(', ')}`);
      }
      state.taggedPaths.clear();
      await loadDirectory(state.currentPath);
    },

    onDedupeCompare: async () => {
      const entry = getSelectedEntry(state);
      if (!entry?.isDirectory) {
        await showConfirm(screen, 'Select a directory first to compare it against another.');
        refreshUI();
        return;
      }

      const otherPath = await showPrompt(
        screen,
        `Compare "${entry.name}" against:`,
        state.currentPath,
        'dedupe-compare'
      );
      if (!otherPath) {
        refreshUI();
        return;
      }

      const resolvedOther = path.resolve(otherPath);
      try {
        const stat = await fs.stat(resolvedOther);
        if (!stat.isDirectory()) {
          await showConfirm(screen, `Not a directory: ${resolvedOther}`);
          refreshUI();
          return;
        }
      } catch {
        await showConfirm(screen, `Directory not found: ${resolvedOther}`);
        refreshUI();
        return;
      }

      // Dry run only: this reads and hashes both trees but never writes
      // anything. Merging (actually copying/moving files) is not wired up
      // yet -- see TODO.md.
      const closeBusy = showBusyMessage(screen, `Scanning and hashing "${entry.name}" and "${path.basename(resolvedOther)}"...`);
      let reportLines: string[];
      try {
        const [manifestA, manifestB] = await Promise.all([
          scanTree(entry.path),
          scanTree(resolvedOther),
        ]);
        const cmp = compareManifests(manifestA, manifestB);
        reportLines = formatComparisonLines(entry.name, path.basename(resolvedOther), cmp);
      } catch (err: any) {
        closeBusy();
        await showConfirm(screen, `Compare failed: ${err.message}`);
        refreshUI();
        return;
      }
      closeBusy();

      await showTextReport(screen, ' Dedupe Compare (dry run) ', reportLines);
      refreshUI();
    },
  });

  // Initial load
  await loadDirectory(startPath);
  await updateDiskInfo(startPath);

  // Start in dir mode with tree focused (matching original XTree)
  state.focusPane = 'tree';
  treePane.widget.focus();
  treePane.setFocused(true);
  filePane.setFocused(false);

  screen.render();

  // Compute directory stats before first render so they appear immediately
  await computeTreeStats();
  refreshUI();
}

main().catch((err) => {
  console.error('XTreeJS fatal error:', err);
  process.exit(1);
});
