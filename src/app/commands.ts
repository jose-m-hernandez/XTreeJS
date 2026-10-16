import * as path from 'path';
import * as fs from 'fs/promises';
import {
  getSelectedEntry,
  getOperationTargets,
  invertTags,
  getVisibleEntries,
  clampSelectedIndex,
  advanceSelectionAfterTagChange,
} from '../state/app-state.js';
import type { SortOrder, DisplayMode } from '../state/app-state.js';
import {
  expandNode, refreshFlatNodes, expandTreeToPath,
  deepDive, findNextSibling,
} from '../state/tree-state.js';
import { listAllFilesRecursive, matchFilespec } from '../fs/list.js';
import { invalidateDirStats } from '../fs/dir-stats.js';
import { viewFile } from '../fs/view.js';
import {
  copyFiles, moveFiles, deleteFiles, pruneDirectory,
  renameFile, makeDirectory, getFileAttributes, setFilePermissions, openInEditor,
  patternRename,
} from '../fs/operations.js';
import type { InputCallbacks } from '../tui/input.js';
import { showPrompt, showConfirm, showAttributes } from '../tui/prompt.js';
import { showHelp, showQuickRef } from '../tui/help-pane.js';
import { showTextReport, showBusyMessage } from '../tui/dedupe-pane.js';
import { scanTree, compareManifests, formatComparisonLines } from '../fs/dedupe.js';
import type { App } from './app.js';

// The key callbacks. Each one resolves app.activePanel() in its own body, at
// call time, so a later change of the active panel is seen by the next key.
export function createCommands(app: App): InputCallbacks {
  const { screen } = app;
  return {
      onNavigate: async (navPath: string) => {
        const p = app.activePanel();
        await p.loadDirectory(navPath);
        // Expand every ancestor down to navPath so the tree has a node for it
        // to select — a shallow "is it already a node?" check missed paths
        // whose ancestors were never individually expanded (e.g. jumping out
        // of branch/showall mode via `\` onto a deeply nested directory).
        await expandTreeToPath(p.treeState, navPath);
        refreshFlatNodes(p.treeState);
        app.refreshUI();
        p.computeTreeStats().catch(() => {}); // fire and forget
      },

      onRefresh: () => {
        app.refreshUI();
      },

      onQuit: () => {
        screen.destroy();
        process.exit(0);
      },

      onCopy: async () => {
        const p = app.activePanel();
        const targets = getOperationTargets(p.state);
        if (targets.length === 0) return;

        const dest = await showPrompt(
          screen,
          `Copy ${targets.length} item(s) to:`,
          p.state.currentPath,
          'copy-dest'
        );
        if (!dest) {
          app.refreshUI();
          return;
        }

        const result = await copyFiles(
          targets.map((t) => t.path),
          dest
        );
        await app.finishFileOperation(targets, result, 'Copy');
      },

      onMove: async () => {
        const p = app.activePanel();
        const targets = getOperationTargets(p.state);
        if (targets.length === 0) return;

        const dest = await showPrompt(
          screen,
          `Move ${targets.length} item(s) to:`,
          p.state.currentPath,
          'move-dest'
        );
        if (!dest) {
          app.refreshUI();
          return;
        }

        const result = await moveFiles(
          targets.map((t) => t.path),
          dest
        );
        await app.finishFileOperation(targets, result, 'Move');
      },

      onDelete: async () => {
        const p = app.activePanel();
        const targets = getOperationTargets(p.state);
        if (targets.length === 0) return;

        const names = targets.map((t) => t.name).join(', ');
        const confirmed = await showConfirm(
          screen,
          `Delete ${targets.length} item(s)? (${names})`
        );
        if (!confirmed) {
          app.refreshUI();
          return;
        }

        const result = await deleteFiles(targets.map((t) => t.path));
        await app.finishFileOperation(targets, result, 'Delete');
      },

      onPrune: async () => {
        const p = app.activePanel();
        const entry = getSelectedEntry(p.state);
        if (!entry?.isDirectory) return;

        const confirmed = await showConfirm(
          screen,
          `PRUNE entire directory tree: ${entry.name}? This cannot be undone easily!`
        );
        if (!confirmed) {
          app.refreshUI();
          return;
        }

        // Double confirmation for prune
        const reallyConfirmed = await showConfirm(
          screen,
          `Are you REALLY sure? All contents of ${entry.name} will be removed.`
        );
        if (!reallyConfirmed) {
          app.refreshUI();
          return;
        }

        const result = await pruneDirectory(entry.path);
        if (!result.success) {
          await showConfirm(screen, `Prune failed: ${result.error}`);
        }
        await p.loadDirectory(p.state.currentPath);
      },

      onView: async () => {
        const p = app.activePanel();
        const entry = getSelectedEntry(p.state);
        if (!entry || entry.isDirectory) return;

        p.state.viewMode = 'viewer';

        const cols = (screen.width as number) || 80;
        const rows = (screen.height as number) || 24;
        const result = await viewFile(entry.path, cols, rows);
        p.state.viewerState = {
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

        app.viewerPane.show(result.lines, entry.path);
      },

      onTabSwitch: () => {
        const p = app.activePanel();
        p.state.focusPane = p.state.focusPane === 'files' ? 'tree' : 'files';
        app.refreshUI();

        if (p.state.focusPane === 'tree') {
          p.treePane.widget.focus();
        } else {
          p.filePane.widget.focus();
        }
      },

      onTreeSelect: async (treePath: string) => {
        const p = app.activePanel();
        await p.loadDirectory(treePath);
        p.computeTreeStats().catch(() => {}); // fire and forget
      },

      onSort: async () => {
        const p = app.activePanel();
        const order: SortOrder[] = ['name', 'ext', 'date', 'size', 'unsorted'];
        const idx = order.indexOf(p.state.sortOrder);
        p.state.sortOrder = order[(idx + 1) % order.length];
        await p.reloadEntries();
        app.refreshUI();
      },

      onSortDirection: async () => {
        const p = app.activePanel();
        p.state.sortDirection = p.state.sortDirection === 'asc' ? 'desc' : 'asc';
        await p.reloadEntries();
        app.refreshUI();
      },

      onFilespec: async () => {
        const p = app.activePanel();
        const spec = await showPrompt(
          screen,
          'Filespec filter (e.g. *.ts *.js):',
          p.state.filespecFilter,
          'filespec'
        );
        if (spec === null) {
          app.refreshUI();
          return;
        }
        // Store previous in history
        if (p.state.filespecFilter !== spec) {
          p.state.filespecHistory.unshift(p.state.filespecFilter);
          if (p.state.filespecHistory.length > 2) p.state.filespecHistory.length = 2;
        }
        p.state.filespecFilter = spec || '*';
        await p.reloadEntries();
        app.refreshUI();
      },

      onToggleFilespec: async () => {
        const p = app.activePanel();
        if (p.state.filespecHistory.length > 0) {
          const prev = p.state.filespecHistory[0];
          p.state.filespecHistory[0] = p.state.filespecFilter;
          p.state.filespecFilter = prev;
          await p.reloadEntries();
          app.refreshUI();
        }
      },

      onInvertTag: () => {
        const p = app.activePanel();
        const entry = getSelectedEntry(p.state);
        if (entry && !entry.isDirectory) {
          if (p.state.taggedPaths.has(entry.path)) {
            p.state.taggedPaths.delete(entry.path);
          } else {
            p.state.taggedPaths.add(entry.path);
          }
          advanceSelectionAfterTagChange(p.state);
          app.refreshUI();
        }
      },

      onInvertAllTags: () => {
        const p = app.activePanel();
        invertTags(p.state);
        app.refreshUI();
      },

      onSpeedNav: (letter: string) => {
        const p = app.activePanel();
        // Find next entry starting with letter, wrapping around
        const visibleEntries = getVisibleEntries(p.state);
        const start = p.state.selectedIndex + 1;
        for (let i = 0; i < visibleEntries.length; i++) {
          const idx = (start + i) % visibleEntries.length;
          if (visibleEntries[idx].name.toUpperCase().startsWith(letter)) {
            p.state.selectedIndex = idx;
            app.refreshUI();
            return;
          }
        }
      },

      onRename: async () => {
        const p = app.activePanel();
        const entry = getSelectedEntry(p.state);
        if (!entry) return;
        const newName = await showPrompt(screen, `Rename ${entry.name} to:`, entry.name, 'rename');
        if (!newName || newName === entry.name) {
          app.refreshUI();
          return;
        }
        const result = await renameFile(entry.path, newName);
        if (!result.success) {
          await showConfirm(screen, `Rename failed: ${result.error}`);
        }
        await p.loadDirectory(p.state.currentPath);
      },

      onMakeDir: async () => {
        const p = app.activePanel();
        const name = await showPrompt(screen, 'New directory name:', '', 'mkdir');
        if (!name) {
          app.refreshUI();
          return;
        }
        const result = await makeDirectory(p.state.currentPath, name);
        if (!result.success) {
          await showConfirm(screen, `Mkdir failed: ${result.error}`);
        }
        // Refresh tree and file list
        invalidateDirStats(p.state.currentPath);
        const node = p.treeState.flatNodes.find((n) => n.path === p.state.currentPath);
        if (node) {
          if (node.expanded) {
            // Re-expand to pick up the new dir
            node.expanded = false;
            node.children = [];
            await expandNode(node);
            refreshFlatNodes(p.treeState);
          }
        }
        await p.loadDirectory(p.state.currentPath);
      },

      onAttributes: async () => {
        const p = app.activePanel();
        const entry = getSelectedEntry(p.state);
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
        app.refreshUI();
      },

      onEditor: async () => {
        const p = app.activePanel();
        const entry = getSelectedEntry(p.state);
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
          app.refreshUI();
          if (p.state.focusPane === 'tree') {
            p.treePane.widget.focus();
          } else {
            p.filePane.widget.focus();
          }
        }
      },

      onDeepDive: async () => {
        const p = app.activePanel();
        const idx = p.treePane.getSelectedIndex();
        const node = p.treeState.flatNodes[idx];
        if (!node) return;
        const target = await deepDive(node);
        refreshFlatNodes(p.treeState);
        await p.loadDirectory(target.path);
        // Select the target node in the tree
        const newIdx = p.treeState.flatNodes.findIndex((n) => n.path === target.path);
        if (newIdx >= 0) {
          p.treePane.widget.select(newIdx);
        }
        app.refreshUI();
        p.computeTreeStats().catch(() => {}); // fire and forget
      },

      onNextSibling: () => {
        const p = app.activePanel();
        const idx = p.treePane.getSelectedIndex();
        const nextIdx = findNextSibling(p.treeState.flatNodes, idx);
        if (nextIdx !== idx) {
          p.treePane.widget.select(nextIdx);
          const node = p.treeState.flatNodes[nextIdx];
          if (node) {
            p.loadDirectory(node.path);
          }
        }
      },

      onPrevSibling: () => {
        // Currently unused but available for future binding
      },

      onTreeRoot: async () => {
        const p = app.activePanel();
        p.treePane.widget.select(0);
        const root = p.treeState.flatNodes[0];
        if (root) {
          await p.loadDirectory(root.path);
        }
      },

      onDisplayCycle: () => {
        const p = app.activePanel();
        const modes: DisplayMode[] = ['dir', 'small', 'expanded'];
        const idx = modes.indexOf(p.state.displayMode);
        p.state.displayMode = modes[(idx + 1) % modes.length];
        // If entering dir mode, switch focus to tree
        if (p.state.displayMode === 'dir') {
          p.state.focusPane = 'tree';
          p.treePane.widget.focus();
        }
        // If entering expanded mode, switch focus to files
        if (p.state.displayMode === 'expanded') {
          p.state.focusPane = 'files';
          p.filePane.widget.focus();
        }
        app.refreshUI();
      },

      onForceRefresh: async () => {
        const p = app.activePanel();
        // Invalidate stats for current dir so they get recomputed
        invalidateDirStats(p.state.currentPath);
        await p.loadDirectory(p.state.currentPath);
        await p.updateDiskInfo(p.state.currentPath);
        app.refreshUI();
        p.computeTreeStats().catch(() => {}); // fire and forget
      },

      onHelp: async () => {
        const p = app.activePanel();
        const context = p.state.focusPane === 'tree' ? 'tree' : 'files';
        await showHelp(screen, context);
        app.refreshUI();
      },

      onQuickRef: async () => {
        await showQuickRef(screen);
        app.refreshUI();
      },

      onBranchMode: async () => {
        const p = app.activePanel();
        await p.toggleRecursiveMode('branch', p.state.currentPath);
      },

      onShowallMode: async () => {
        const p = app.activePanel();
        await p.toggleRecursiveMode('showall', p.treeState.root.path);
      },

      onTagByFilespec: async () => {
        const p = app.activePanel();
        const pattern = await showPrompt(screen, 'Tag files matching:', '*', 'tag-filespec');
        if (!pattern) {
          app.refreshUI();
          return;
        }
        for (const entry of p.state.entries) {
          if (!entry.isDirectory && matchFilespec(entry.name, pattern)) {
            p.state.taggedPaths.add(entry.path);
          }
        }
        app.refreshUI();
      },

      onUntagByFilespec: async () => {
        const p = app.activePanel();
        const pattern = await showPrompt(screen, 'Untag files matching:', '*', 'tag-filespec');
        if (!pattern) {
          app.refreshUI();
          return;
        }
        for (const entry of p.state.entries) {
          if (!entry.isDirectory && matchFilespec(entry.name, pattern)) {
            p.state.taggedPaths.delete(entry.path);
          }
        }
        app.refreshUI();
      },

      onTagAllGlobal: async () => {
        const p = app.activePanel();
        const allFiles = await listAllFilesRecursive(p.treeState.root.path);
        for (const fp of allFiles) {
          p.state.taggedPaths.add(fp);
        }
        app.refreshUI();
      },

      onUntagAllGlobal: () => {
        const p = app.activePanel();
        p.state.taggedPaths.clear();
        app.refreshUI();
      },

      onToggleTaggedOnly: () => {
        const p = app.activePanel();
        p.state.showTaggedOnly = !p.state.showTaggedOnly;
        clampSelectedIndex(p.state);
        app.refreshUI();
      },

      onPatternRename: async () => {
        const p = app.activePanel();
        if (p.state.taggedPaths.size === 0) {
          await showConfirm(screen, 'No tagged files to rename.');
          app.refreshUI();
          return;
        }
        const fromPattern = await showPrompt(screen, 'Rename FROM pattern (e.g. *.txt):', '', 'pattern-rename');
        if (!fromPattern) {
          app.refreshUI();
          return;
        }
        const toPattern = await showPrompt(screen, 'Rename TO pattern (e.g. *.md):', '', 'pattern-rename');
        if (!toPattern) {
          app.refreshUI();
          return;
        }
        const taggedFiles = [...p.state.taggedPaths];
        const confirmed = await showConfirm(
          screen,
          `Rename ${taggedFiles.length} tagged file(s): ${fromPattern} → ${toPattern}?`
        );
        if (!confirmed) {
          app.refreshUI();
          return;
        }
        const result = await patternRename(taggedFiles, fromPattern, toPattern);
        if (!result.success) {
          await showConfirm(screen, `Rename errors: ${result.errors.join(', ')}`);
        }
        p.state.taggedPaths.clear();
        await p.loadDirectory(p.state.currentPath);
      },

      onDedupeCompare: async () => {
        const p = app.activePanel();
        const entry = getSelectedEntry(p.state);
        if (!entry?.isDirectory) {
          await showConfirm(screen, 'Select a directory first to compare it against another.');
          app.refreshUI();
          return;
        }

        const otherPath = await showPrompt(
          screen,
          `Compare "${entry.name}" against:`,
          p.state.currentPath,
          'dedupe-compare'
        );
        if (!otherPath) {
          app.refreshUI();
          return;
        }

        const resolvedOther = path.resolve(otherPath);
        try {
          const stat = await fs.stat(resolvedOther);
          if (!stat.isDirectory()) {
            await showConfirm(screen, `Not a directory: ${resolvedOther}`);
            app.refreshUI();
            return;
          }
        } catch {
          await showConfirm(screen, `Directory not found: ${resolvedOther}`);
          app.refreshUI();
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
          app.refreshUI();
          return;
        }
        closeBusy();

        await showTextReport(screen, ' Dedupe Compare (dry run) ', reportLines);
        app.refreshUI();
      },
  };
}
