import blessed from 'neo-blessed';
import { bgFg, Colors, fg } from '../config/defaults.js';
import type { FileEntry } from '../fs/list.js';
import { formatSize } from '../util/format.js';
import type { DisplayMode, ListingMode } from '../state/app-state.js';

export interface FilePane {
  widget: blessed.Widgets.ListElement;
  refresh(entries: FileEntry[], taggedPaths: Set<string>): void;
  setFocused(focused: boolean): void;
  getSelectedIndex(): number;
  setSelectedIndex(index: number): void;
  setDisplayMode(mode: DisplayMode): void;
  setListingMode(mode: ListingMode): void;
}

function colorForEntry(entry: FileEntry): string {
  if (entry.isDirectory) return Colors.directory;
  if (entry.isSymlink) return Colors.symlink;
  if (entry.name.startsWith('.')) return Colors.hidden;
  if (entry.isExecutable) return Colors.executable;
  return Colors.default;
}

function formatDate(mtime: Date): string {
  const m = (mtime.getMonth() + 1).toString().padStart(2, '0');
  const d = mtime.getDate().toString().padStart(2, '0');
  const y = mtime.getFullYear().toString().slice(-2);
  return `${m}/${d}/${y}`;
}

export function createFilePane(screen: blessed.Widgets.Screen): FilePane {
  const widget = blessed.list({
    parent: screen,
    label: ' Files ',
    left: '40%',
    top: 1, // below status bar
    width: '60%',
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

  function formatEntry(entry: FileEntry, isTagged: boolean): string {
    const color = colorForEntry(entry);
    const prefix = isTagged ? `${bgFg('*', Colors.taggedBg, Colors.taggedFg)} ` : '  ';
    const typeIndicator = entry.isDirectory
      ? fg('<DIR>', Colors.valueFg)
      : formatSize(entry.size);
    const date = formatDate(entry.mtime);
    const name = entry.name + (entry.isDirectory ? '/' : '');

    // Pad name to 30 chars for alignment
    const paddedName = name.length > 35 ? name.slice(0, 34) + '~' : name;

    // Names are data, not markup: escape any {tag} text after truncating.
    return `${prefix}${fg(blessed.escape(paddedName), color)}  ${typeIndicator.padStart(8)}  ${date}`;
  }

  function refresh(entries: FileEntry[], taggedPaths: Set<string>): void {
    const items = entries.map((e) =>
      formatEntry(e, taggedPaths.has(e.path))
    );
    widget.setItems(items as any);
  }

  function setFocused(focused: boolean): void {
    (widget.style.border as any).fg = focused
      ? Colors.borderFocused
      : Colors.border;
  }

  function getSelectedIndex(): number {
    return (widget as any).selected ?? 0;
  }

  function setSelectedIndex(index: number): void {
    widget.select(index);
  }

  function setDisplayMode(mode: DisplayMode): void {
    if (mode === 'dir') {
      // dir mode — file pane below tree, left 75%
      // Overlap tree's bottom border by 1 row to avoid double line
      widget.left = 0;
      widget.top = '50%-1';
      widget.width = '75%';
      widget.height = '50%';
      widget.show();
    } else if (mode === 'small') {
      widget.left = '40%';
      widget.top = 1;
      widget.width = '60%';
      widget.height = '100%-2';
      widget.show();
    } else {
      // expanded — full width
      widget.left = 0;
      widget.top = 1;
      widget.width = '100%';
      widget.height = '100%-2';
      widget.show();
    }
  }

  function setListingMode(mode: ListingMode): void {
    const labels: Record<ListingMode, string> = {
      normal: ' Files ',
      branch: ' Branch ',
      showall: ' Showall ',
    };
    widget.setLabel(labels[mode]);
  }

  return { widget, refresh, setFocused, getSelectedIndex, setSelectedIndex, setDisplayMode, setListingMode };
}
