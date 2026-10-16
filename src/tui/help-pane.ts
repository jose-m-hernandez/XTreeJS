import blessed from 'neo-blessed';
import { Colors, fg } from '../config/defaults.js';

type HelpContext = 'files' | 'tree' | 'viewer';

interface HelpEntry {
  key: string;
  description: string;
}

const FILE_HELP: HelpEntry[] = [
  { key: 'Up/k', description: 'Move cursor up' },
  { key: 'Down/j', description: 'Move cursor down' },
  { key: 'Enter/Right', description: 'Enter directory / Cycle display mode' },
  { key: 'Left/h', description: 'Go to parent directory' },
  { key: 'Home', description: 'Jump to first entry' },
  { key: 'End', description: 'Jump to last entry' },
  { key: 'PgUp/PgDn', description: 'Page up / page down' },
  { key: '\\', description: 'Go to root / exit branch mode' },
  { key: 'Tab', description: 'Switch to tree pane' },
  { key: 't', description: 'Tag/untag current file' },
  { key: 'T', description: 'Tag all files' },
  { key: 'u', description: 'Untag current file' },
  { key: 'U', description: 'Untag all files' },
  { key: 'i', description: 'Invert tag on current file' },
  { key: 'Ctrl+i', description: 'Invert all tags' },
  { key: '+/=', description: 'Tag files by filespec pattern' },
  { key: '-', description: 'Untag files by filespec pattern' },
  { key: 'Ctrl+T', description: 'Tag ALL files across entire tree' },
  { key: 'Ctrl+U', description: 'Untag ALL files across entire tree' },
  { key: 'Ctrl+G', description: 'Toggle show tagged files only' },
  { key: 'Ctrl+N', description: 'Pattern rename tagged files' },
  { key: 'Ctrl+D', description: 'Compare selected directory against another (dry run, read-only)' },
  { key: 'b', description: 'Branch mode (recursive listing)' },
  { key: 's', description: 'Cycle sort order' },
  { key: 'S', description: 'Toggle sort direction' },
  { key: 'f', description: 'Set filespec filter' },
  { key: 'Ctrl+f', description: 'Toggle last two filespecs' },
  { key: 'n/r', description: 'Rename file' },
  { key: 'a', description: 'View file attributes' },
  { key: 'e/F4', description: 'Open in external editor' },
  { key: 'c/F5', description: 'Copy file(s)' },
  { key: 'm/F6', description: 'Move file(s)' },
  { key: 'd/F7', description: 'Delete file(s)' },
  { key: 'F8', description: 'Prune directory' },
  { key: 'F3/v', description: 'View file' },
  { key: 'F2', description: 'Force refresh' },
  { key: 'Shift+A-Z', description: 'Speed nav: jump to letter' },
  { key: 'q/x', description: 'Quit' },
  { key: '?/F1', description: 'This help screen' },
];

const TREE_HELP: HelpEntry[] = [
  { key: 'Up/k', description: 'Move cursor up' },
  { key: 'Down/j', description: 'Move cursor down' },
  { key: 'Right/l', description: 'Deep-dive into directory' },
  { key: 'Left/h', description: 'Collapse current node' },
  { key: 'Enter', description: 'Expand/navigate to directory' },
  { key: 'Home', description: 'Jump to root' },
  { key: '+/=', description: 'Expand directory' },
  { key: '-', description: 'Collapse directory' },
  { key: '*', description: 'Toggle expand/collapse' },
  { key: '`', description: 'Jump to next sibling' },
  { key: 's', description: 'Showall mode (recursive from root)' },
  { key: 'Tab', description: 'Switch to file pane' },
  { key: 'm', description: 'Create new directory' },
  { key: 'F2', description: 'Force refresh' },
  { key: '\\', description: 'Go to root directory' },
  { key: 'q/x', description: 'Quit' },
  { key: '?/F1', description: 'This help screen' },
];

const VIEWER_HELP: HelpEntry[] = [
  { key: 'Up/k', description: 'Scroll up one line' },
  { key: 'Down/j', description: 'Scroll down one line' },
  { key: 'PgUp', description: 'Page up' },
  { key: 'PgDn/Space', description: 'Page down / next match' },
  { key: 'Home', description: 'Jump to start' },
  { key: 'End', description: 'Jump to end' },
  { key: 'h/d', description: 'Toggle hex dump mode' },
  { key: 'a', description: 'Toggle ASCII mode (no highlighting)' },
  { key: 'J (shift)', description: 'Toggle junk mode (strip non-printable)' },
  { key: 's/F9', description: 'Search in file' },
  { key: 'n', description: 'Next search match' },
  { key: 'N', description: 'Previous search match' },
  { key: 'w', description: 'Toggle word wrap' },
  { key: 't', description: 'Toggle tab size (4/8)' },
  { key: 'f', description: 'Toggle follow/tail mode' },
  { key: 'g', description: 'Gather text (mark range, copy)' },
  { key: 'Esc', description: 'Cancel gather / exit viewer' },
  { key: 'q', description: 'Exit viewer' },
];

const HELP_MAP: Record<HelpContext, { title: string; entries: HelpEntry[] }> = {
  files: { title: 'File Pane Commands', entries: FILE_HELP },
  tree: { title: 'Tree Pane Commands', entries: TREE_HELP },
  viewer: { title: 'Viewer Commands', entries: VIEWER_HELP },
};

function wrapText(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function formatHelp(entries: HelpEntry[], width: number): string[] {
  const keyWidth = 16;
  const indent = 2; // leading spaces before the key column
  const gap = 1; // space between key and description
  const border = 2; // box border consumes a column on each side
  // Wrap the description into the space actually left over once the box
  // border, indent, and key column are accounted for, so narrow terminals
  // (small `width`) don't clip or overflow the description text.
  const descWidth = Math.max(10, width - border - indent - keyWidth - gap);
  const lines: string[] = [];
  for (const entry of entries) {
    const key = entry.key.padEnd(keyWidth);
    const wrapped = wrapText(entry.description, descWidth);
    wrapped.forEach((line, i) => {
      const prefix = i === 0 ? fg(key, Colors.valueFg) : ' '.repeat(keyWidth);
      lines.push(`  ${prefix} ${line}`);
    });
  }
  return lines;
}

export function showHelp(
  screen: blessed.Widgets.Screen,
  context: HelpContext
): Promise<void> {
  return new Promise((resolve) => {
    const helpData = HELP_MAP[context];
    const width = Math.min(70, (screen.width as number) - 4);
    const helpLines = formatHelp(helpData.entries, width);
    const content = helpLines.join('\n');

    const box = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: width,
      height: Math.min(helpLines.length + 4, (screen.height as number) - 2),
      border: { type: 'line' },
      style: {
        bg: Colors.bg,
        fg: Colors.default,
        border: { fg: Colors.borderFocused, bg: Colors.bg },
        label: { fg: Colors.titleFg, bold: true },
      },
      label: ` ${helpData.title} `,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '█',
        style: { fg: Colors.border },
      },
      content: `\n${content}\n\n  ${fg('Press q, Esc, or ? to close', Colors.valueFg)}`,
    });

    screen.render();

    const handler = (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
      if (key.name === 'q' || key.name === 'escape' || ch === '?') {
        screen.removeListener('keypress', handler);
        box.destroy();
        screen.render();
        resolve();
      } else if (key.name === 'up' || ch === 'k') {
        box.scroll(-1);
        screen.render();
      } else if (key.name === 'down' || ch === 'j') {
        box.scroll(1);
        screen.render();
      }
    };

    screen.on('keypress', handler);
  });
}

export function showQuickRef(
  screen: blessed.Widgets.Screen
): Promise<void> {
  return new Promise((resolve) => {
    const lines = [
      '',
      `  ${fg('XTreeJS Quick Reference', Colors.valueFg)}`,
      '',
      `  ${fg('Navigation', Colors.valueFg)}`,
      '  ↑↓/jk  Move cursor    ←→/hl  Back/Enter     Tab  Switch pane',
      '  Home/End  First/Last   PgUp/PgDn  Page        \\  Root dir',
      '',
      `  ${fg('File Operations', Colors.valueFg)}`,
      '  c/F5  Copy     m/F6  Move      d/F7  Delete     F8  Prune',
      '  n/r   Rename   e/F4  Editor    a  Attributes',
      '',
      `  ${fg('Tagging', Colors.valueFg)}`,
      '  t  Tag       T  Tag all      u  Untag      U  Untag all',
      '  i  Invert    Ctrl+i  Invert all',
      '  +  Tag spec  -  Untag spec   Ctrl+T  Tag tree  Ctrl+U  Untag tree',
      '  Ctrl+G  Show tagged only     Ctrl+N  Pattern rename',
      '',
      `  ${fg('Sort & Filter', Colors.valueFg)}`,
      '  s  Sort      S  Direction    f  Filespec    Ctrl+f  Toggle filter',
      '',
      `  ${fg('Branch & Showall', Colors.valueFg)}`,
      '  b  Branch mode (recursive)   s  Showall (in tree pane)',
      '  \\  Jump to file parent (in branch/showall)',
      '',
      `  ${fg('Viewer', Colors.valueFg)}`,
      '  F3/v  View   h  Hex  a  ASCII  j  Junk  s  Search  w  Wrap',
      '  f  Follow/tail mode           g  Gather/copy text',
      '',
      `  ${fg('Prompts', Colors.valueFg)}`,
      '  Up/Down  History recall        F3  Paste last response',
      '  Ctrl+Bksp  Clear line',
      '',
      `  ${fg('Tree', Colors.valueFg)}`,
      '  +  Expand    -  Collapse     *  Toggle      `  Next sibling',
      '  Right  Deep-dive             m  MkDir (tree focus)',
      '',
      '  F1/?  Help   F2  Refresh     F10  This card   q/x  Quit',
      '',
      `  ${fg('Press any key to close', Colors.valueFg)}`,
    ];

    const box = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: Math.min(72, (screen.width as number) - 4),
      height: Math.min(lines.length + 2, (screen.height as number) - 2),
      border: { type: 'line' },
      style: {
        bg: Colors.bg,
        fg: Colors.default,
        border: { fg: Colors.borderFocused, bg: Colors.bg },
      },
      tags: true,
      content: lines.join('\n'),
    });

    screen.render();

    const handler = () => {
      screen.removeListener('keypress', handler);
      box.destroy();
      screen.render();
      resolve();
    };

    screen.on('keypress', handler);
  });
}
