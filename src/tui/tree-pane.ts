import blessed from 'neo-blessed';
import { Colors, fg, TreeChars } from '../config/defaults.js';
import type { TreeNode } from '../state/tree-state.js';
import { getCachedDirStats, formatStatsSize } from '../fs/dir-stats.js';

import type { DisplayMode } from '../state/app-state.js';

export interface TreePane {
  widget: blessed.Widgets.ListElement;
  /** `currentPath` is only highlighted; the cursor goes where `selectedIndex` says. */
  refresh(nodes: TreeNode[], currentPath: string, selectedIndex: number): void;
  setFocused(focused: boolean): void;
  getSelectedIndex(): number;
  setDisplayMode(mode: DisplayMode): void;
}

export function createTreePane(screen: blessed.Widgets.Screen): TreePane {
  const widget = blessed.list({
    parent: screen,
    label: ' Tree ',
    left: 0,
    top: 1, // below status bar
    width: '40%',
    height: '100%-2', // leave room for top and bottom bars
    border: { type: 'line' },
    style: {
      bg: Colors.bg,
      border: { fg: Colors.border, bg: Colors.bg },
      label: { fg: Colors.titleFg, bg: Colors.bg, bold: true },
      selected: { bg: Colors.selectionBg, fg: Colors.selectionFg },
      item: { fg: Colors.default, bg: Colors.bg },
    },
    keys: false,
    vi: false,
    mouse: false,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: '█',
      style: { fg: Colors.border },
    },
    tags: true,
  } as any);

  function formatTreeLine(node: TreeNode, currentPath: string): string {
    const indent = '  '.repeat(node.depth);
    let prefix = '';
    if (node.depth > 0) {
      prefix = node.isLast ? TreeChars.elbow : TreeChars.tee;
      prefix += ' ';
    }
    const expandIcon = node.hasSubdirs
      ? node.expanded
        ? TreeChars.expanded
        : TreeChars.collapsed
      : '   ';

    const name = blessed.escape(node.name);
    const isCurrent = node.path === currentPath;
    const color = isCurrent ? Colors.selectionBg : Colors.directory;

    // Show directory stats if cached
    const stats = getCachedDirStats(node.path);
    let statsStr = '';
    if (stats) {
      const sizeStr = formatStatsSize(stats.totalSize);
      statsStr = `  ${fg(`${stats.fileCount} files  ${sizeStr}`, Colors.valueFg)}`;
    }

    return `${indent}${prefix}${fg(`${expandIcon} ${name}`, color)}${statsStr}`;
  }

  function refresh(nodes: TreeNode[], currentPath: string, selectedIndex: number): void {
    const items = nodes.map((n) => formatTreeLine(n, currentPath));
    widget.setItems(items as any);
    if (nodes.length > 0) {
      widget.select(Math.min(Math.max(0, selectedIndex), nodes.length - 1));
    }
  }

  function setFocused(focused: boolean): void {
    (widget.style.border as any).fg = focused
      ? Colors.borderFocused
      : Colors.border;
    // Only steal keyboard focus when actually becoming focused — calling
    // this unconditionally would yank focus back to the tree on every
    // refreshUI() even while the file pane is focused.
    if (focused) {
      widget.focus();
    }
  }

  function getSelectedIndex(): number {
    return (widget as any).selected ?? 0;
  }

  function setDisplayMode(mode: DisplayMode): void {
    if (mode === 'dir') {
      widget.width = '75%';
      widget.top = 1;
      widget.height = '50%-1';
      widget.show();
    } else if (mode === 'small') {
      widget.width = '40%';
      widget.top = 1;
      widget.height = '100%-2';
      widget.show();
    } else {
      // expanded — hide tree
      widget.hide();
    }
  }

  return { widget, refresh, setFocused, getSelectedIndex, setDisplayMode };
}
