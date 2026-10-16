// The normal-mode keymap, as data. Each row binds blessed key names (the
// `full` name blessed puts on every key event: 'q', 'S-t' for Shift+T, 'C-d'
// for Ctrl+D, 'f5', '+') to an action, in a pane scope. Modals are not here:
// they are layers on the key router and see keys before this table does.

import type { FocusPane } from '../state/app-state.js';
import type { InputCallbacks } from './input.js';

export type Scope = 'any' | FocusPane;

/** Actions input.ts implements itself, because they read or move state. */
export type LocalAction =
  | 'cursor-up'
  | 'cursor-down'
  | 'enter'
  | 'right'
  | 'left'
  | 'root'
  | 'home'
  | 'end'
  | 'page-up'
  | 'page-down'
  | 'tag-toggle'
  | 'tag-all'
  | 'untag-current'
  | 'untag-all'
  | 'tree-expand'
  | 'tree-collapse'
  | 'tree-toggle'
  | 'speed-nav';

/** Callbacks that take no argument, so a row can name them directly. */
export type DirectAction = Exclude<
  keyof InputCallbacks,
  'onNavigate' | 'onTreeSelect' | 'onSpeedNav'
>;

export interface KeyBinding {
  keys: string[];
  scope: Scope;
  action: DirectAction | LocalAction;
  /** The key label of the entry that documents this row in help-pane's tables. */
  help?: string;
}

// Shift+A..Z jump to a name; S, T and U are taken by sort direction and tagging.
const SPEED_NAV_KEYS = 'abcdefghijklmnopqrstuvwxyz'
  .split('')
  .filter((l) => !'stu'.includes(l))
  .map((l) => `S-${l}`);

export const KEYMAP: KeyBinding[] = [
  { keys: ['q', 'x'], scope: 'any', action: 'onQuit', help: 'q/x' },
  { keys: ['tab'], scope: 'any', action: 'onTabSwitch', help: 'Tab' },

  // Movement
  { keys: ['up', 'k'], scope: 'any', action: 'cursor-up', help: 'Up/k' },
  { keys: ['down', 'j'], scope: 'any', action: 'cursor-down', help: 'Down/j' },
  { keys: ['enter'], scope: 'any', action: 'enter', help: 'Enter/Right' },
  { keys: ['right', 'l'], scope: 'any', action: 'right', help: 'Right/l' },
  { keys: ['left', 'backspace', 'h'], scope: 'any', action: 'left', help: 'Left/h' },
  { keys: ['\\'], scope: 'any', action: 'root', help: '\\' },
  { keys: ['home'], scope: 'any', action: 'home', help: 'Home' },
  { keys: ['end'], scope: 'files', action: 'end', help: 'End' },
  { keys: ['pageup'], scope: 'files', action: 'page-up', help: 'PgUp/PgDn' },
  { keys: ['pagedown'], scope: 'files', action: 'page-down', help: 'PgUp/PgDn' },

  // Tagging
  { keys: ['t'], scope: 'files', action: 'tag-toggle', help: 't' },
  { keys: ['S-t'], scope: 'any', action: 'tag-all', help: 'T' },
  { keys: ['u'], scope: 'files', action: 'untag-current', help: 'u' },
  { keys: ['S-u'], scope: 'any', action: 'untag-all', help: 'U' },
  { keys: ['i'], scope: 'files', action: 'onInvertTag', help: 'i' },
  { keys: ['+', '='], scope: 'files', action: 'onTagByFilespec', help: '+/=' },
  { keys: ['-'], scope: 'files', action: 'onUntagByFilespec', help: '-' },
  { keys: ['C-t'], scope: 'any', action: 'onTagAllGlobal', help: 'Ctrl+T' },
  { keys: ['C-u'], scope: 'any', action: 'onUntagAllGlobal', help: 'Ctrl+U' },
  { keys: ['C-g'], scope: 'any', action: 'onToggleTaggedOnly', help: 'Ctrl+G' },
  { keys: ['C-n'], scope: 'any', action: 'onPatternRename', help: 'Ctrl+N' },
  { keys: ['C-d'], scope: 'files', action: 'onDedupeCompare', help: 'Ctrl+D' },

  // Tree
  { keys: ['+', '='], scope: 'tree', action: 'tree-expand', help: '+/=' },
  { keys: ['-'], scope: 'tree', action: 'tree-collapse', help: '-' },
  { keys: ['*'], scope: 'tree', action: 'tree-toggle', help: '*' },
  { keys: ['`'], scope: 'tree', action: 'onNextSibling', help: '`' },
  { keys: ['m'], scope: 'tree', action: 'onMakeDir', help: 'm' },
  { keys: ['s'], scope: 'tree', action: 'onShowallMode', help: 's' },

  // File operations
  { keys: ['c', 'f5'], scope: 'any', action: 'onCopy', help: 'c/F5' },
  { keys: ['f6'], scope: 'any', action: 'onMove', help: 'm/F6' },
  { keys: ['m'], scope: 'files', action: 'onMove', help: 'm/F6' },
  { keys: ['d', 'f7'], scope: 'any', action: 'onDelete', help: 'd/F7' },
  { keys: ['f8'], scope: 'any', action: 'onPrune', help: 'F8' },
  { keys: ['f3', 'v'], scope: 'any', action: 'onView', help: 'F3/v' },
  { keys: ['n', 'r'], scope: 'files', action: 'onRename', help: 'n/r' },
  { keys: ['a'], scope: 'files', action: 'onAttributes', help: 'a' },
  { keys: ['e', 'f4'], scope: 'any', action: 'onEditor', help: 'e/F4' },
  { keys: ['f2'], scope: 'any', action: 'onForceRefresh', help: 'F2' },

  // Sorting, filtering, listing modes
  { keys: ['s'], scope: 'files', action: 'onSort', help: 's' },
  { keys: ['S-s'], scope: 'any', action: 'onSortDirection', help: 'S' },
  { keys: ['f'], scope: 'files', action: 'onFilespec', help: 'f' },
  { keys: ['C-f'], scope: 'any', action: 'onToggleFilespec', help: 'Ctrl+f' },
  { keys: ['b'], scope: 'files', action: 'onBranchMode', help: 'b' },

  // Help
  { keys: ['?', 'f1'], scope: 'any', action: 'onHelp', help: '?/F1' },
  { keys: ['f10'], scope: 'any', action: 'onQuickRef' },

  { keys: SPEED_NAV_KEYS, scope: 'files', action: 'speed-nav', help: 'Shift+A-Z' },
];

/** The row a key press resolves to in the given pane, if any. */
export function findBinding(full: string, pane: FocusPane): KeyBinding | undefined {
  return KEYMAP.find(
    (row) => row.keys.includes(full) && (row.scope === 'any' || row.scope === pane)
  );
}
