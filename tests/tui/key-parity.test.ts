// Characterization of normal-mode key handling: every bound key, pressed on
// each pane, against the real setupInput. Each row is a literal expectation of
// which callbacks fire (and with what) and which AppState fields change.
//
// Written against the pre-router code and kept green through the refactor.
// A row that was edited by a deliberate bug fix carries `// changed by B<n>`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHeadlessScreen, flush, press } from '../helpers/headless-screen.js';
import { setupInput, type InputCallbacks } from '../../src/tui/input.js';
import type { TreePane } from '../../src/tui/tree-pane.js';
import { createAppState, type AppState } from '../../src/state/app-state.js';
import {
  createTreeNode,
  expandNode,
  flattenTree,
  type TreeState,
} from '../../src/state/tree-state.js';
import type { FileEntry } from '../../src/fs/list.js';
import { KEYMAP, findBinding, type Scope } from '../../src/tui/keymap.js';
import { FILE_HELP, TREE_HELP, type HelpEntry } from '../../src/tui/help-pane.js';

type Pane = 'files' | 'tree';
type Changes = Record<string, unknown>;

interface Row {
  key: string;
  pane: Pane;
  fired: string[];
  changes?: Changes;
  /** Optional per-row arrangement of the fixture before the key is pressed. */
  setup?: (f: Fixture) => void;
  label?: string;
}

interface Fixture {
  T: string;
  state: AppState;
  treeState: TreeState;
  treeSelected: { value: number };
}

let T: string;

beforeAll(() => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'xtree-parity-'));
  fs.mkdirSync(path.join(T, 'sub1', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(T, 'sub2'));
});

afterAll(() => {
  fs.rmSync(T, { recursive: true, force: true });
});

function entry(dir: string, name: string, isDirectory: boolean): FileEntry {
  return {
    name,
    path: path.join(dir, name),
    isDirectory,
    isSymlink: false,
    isExecutable: false,
    size: 10,
    mtime: new Date(0),
  };
}

async function makeFixture(pane: Pane): Promise<Fixture> {
  const work = path.join(T, 'work');
  const state = createAppState(work);
  state.entries = [
    entry(work, 'adir', true),
    entry(work, 'a.txt', false),
    entry(work, 'b.txt', false),
    entry(work, 'c.txt', false),
  ];
  state.selectedIndex = 1;
  state.focusPane = pane;

  const root = await createTreeNode(T, 0, true);
  await expandNode(root);
  root.expanded = true;
  // flatNodes: [T, T/sub1 (collapsed, has subdirs), T/sub2]
  const treeState: TreeState = { root, flatNodes: flattenTree(root) };
  return { T, state, treeState, treeSelected: { value: 1 } };
}

function snapshot(state: AppState): Changes {
  return {
    selectedIndex: state.selectedIndex,
    focusPane: state.focusPane,
    listingMode: state.listingMode,
    branchBasePath: state.branchBasePath,
    showTaggedOnly: state.showTaggedOnly,
    sortOrder: state.sortOrder,
    currentPath: state.currentPath,
    tagged: [...state.taggedPaths].map((p) => path.basename(p)).sort(),
  };
}

function diff(before: Changes, after: Changes): Changes {
  const out: Changes = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = after[k];
  }
  return out;
}

function parseKey(spec: string): { name: string; opts: { ctrl?: boolean; shift?: boolean } } {
  if (spec.startsWith('C-')) return { name: spec.slice(2), opts: { ctrl: true } };
  if (spec.startsWith('S-')) return { name: spec.slice(2), opts: { shift: true } };
  return { name: spec, opts: {} };
}

/** Run one key press against the real setupInput and report what happened. */
async function run(row: Row): Promise<{ fired: string[]; changes: Changes }> {
  const f = await makeFixture(row.pane);
  row.setup?.(f);
  const { screen, destroy } = createHeadlessScreen();
  const log: string[] = [];
  const rec = (name: string) => (...args: unknown[]) => {
    log.push(args.length ? `${name}:${args.join(',')}` : name);
  };

  const treePane = {
    widget: {
      up: rec('tree.up'),
      down: rec('tree.down'),
      select: (i: number) => {
        f.treeSelected.value = i;
        log.push(`tree.select:${i}`);
      },
    },
    getSelectedIndex: () => f.treeSelected.value,
  } as unknown as TreePane;

  // Every callback, so a missing name is a compile error.
  const callbacks: InputCallbacks = {
    onNavigate: rec('onNavigate'),
    onRefresh: rec('onRefresh'),
    onQuit: rec('onQuit'),
    onCopy: rec('onCopy'),
    onMove: rec('onMove'),
    onDelete: rec('onDelete'),
    onPrune: rec('onPrune'),
    onView: rec('onView'),
    onTabSwitch: rec('onTabSwitch'),
    onTreeSelect: rec('onTreeSelect'),
    onSort: rec('onSort'),
    onSortDirection: rec('onSortDirection'),
    onFilespec: rec('onFilespec'),
    onToggleFilespec: rec('onToggleFilespec'),
    onInvertTag: rec('onInvertTag'),
    onInvertAllTags: rec('onInvertAllTags'),
    onSpeedNav: rec('onSpeedNav'),
    onRename: rec('onRename'),
    onMakeDir: rec('onMakeDir'),
    onAttributes: rec('onAttributes'),
    onEditor: rec('onEditor'),
    onDeepDive: rec('onDeepDive'),
    onNextSibling: rec('onNextSibling'),
    onPrevSibling: rec('onPrevSibling'),
    onTreeRoot: rec('onTreeRoot'),
    onDisplayCycle: rec('onDisplayCycle'),
    onForceRefresh: rec('onForceRefresh'),
    onHelp: rec('onHelp'),
    onQuickRef: rec('onQuickRef'),
    onBranchMode: rec('onBranchMode'),
    onShowallMode: rec('onShowallMode'),
    onTagByFilespec: rec('onTagByFilespec'),
    onUntagByFilespec: rec('onUntagByFilespec'),
    onTagAllGlobal: rec('onTagAllGlobal'),
    onUntagAllGlobal: rec('onUntagAllGlobal'),
    onToggleTaggedOnly: rec('onToggleTaggedOnly'),
    onPatternRename: rec('onPatternRename'),
    onDedupeCompare: rec('onDedupeCompare'),
  };

  try {
    setupInput(screen, f.state, f.treeState, treePane, callbacks);
    const before = snapshot(f.state);
    const { name, opts } = parseKey(row.key);
    press(screen, name, opts);
    await flush();
    return {
      fired: log.map((l) => l.split(T).join('$T')),
      changes: diff(before, snapshot(f.state)),
    };
  } finally {
    destroy();
  }
}

const files = (keys: string[], fired: string[], changes: Changes = {}): Row[] =>
  keys.map((key) => ({ key, pane: 'files' as const, fired, changes }));
const tree = (keys: string[], fired: string[], changes: Changes = {}): Row[] =>
  keys.map((key) => ({ key, pane: 'tree' as const, fired, changes }));
const both = (keys: string[], fired: string[], changes: Changes = {}): Row[] => [
  ...files(keys, fired, changes),
  ...tree(keys, fired, changes),
];

const SPEED_NAV_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('').filter((l) => !'stu'.includes(l));

const ROWS: Row[] = [
  // Quit
  ...both(['q', 'x', 'C-c'], ['onQuit']),
  // Pane switch
  ...both(['tab'], ['onTabSwitch']),
  // Cursor up/down: files move selectedIndex; tree moves the list widget
  ...files(['up', 'k'], ['onRefresh'], { selectedIndex: 0 }),
  ...tree(['up', 'k'], ['tree.up:1']),
  ...files(['down', 'j'], ['onRefresh'], { selectedIndex: 2 }),
  ...tree(['down', 'j'], ['tree.down:1']),
  // Enter: files cycle display on a file; tree expands a collapsed node and selects it
  ...files(['enter'], ['onDisplayCycle']),
  ...tree(['enter'], ['onTreeSelect:$T/sub1']),
  // Right: files only enter directories; tree deep-dives
  ...files(['right', 'l'], []),
  ...tree(['right', 'l'], ['onDeepDive']),
  // Left: files go to the parent directory; tree jumps to the parent node
  ...files(['left', 'backspace', 'h'], ['onNavigate:$T']),
  ...tree(['left', 'backspace', 'h'], ['tree.select:0', 'onTreeSelect:$T']),
  // Backslash: root
  ...both(['\\'], ['onNavigate:/']),
  // Home / End / paging
  ...files(['home'], ['onRefresh'], { selectedIndex: 0 }),
  ...tree(['home'], ['onTreeRoot']),
  ...files(['end'], ['onRefresh'], { selectedIndex: 3 }),
  ...tree(['end'], []),
  ...files(['pageup'], ['onRefresh'], { selectedIndex: 0 }),
  ...tree(['pageup'], []),
  ...files(['pagedown'], ['onRefresh'], { selectedIndex: 3 }),
  ...tree(['pagedown'], []),
  // Tagging
  ...files(['t'], ['onRefresh'], { tagged: ['a.txt'], selectedIndex: 2 }),
  ...tree(['t'], []),
  ...both(['S-t'], ['onRefresh'], { tagged: ['a.txt', 'b.txt', 'c.txt'] }),
  ...files(['u'], ['onRefresh'], { selectedIndex: 2 }),
  ...tree(['u'], []),
  ...both(['S-u'], ['onRefresh']),
  // Tree expand/collapse vs. filespec tagging share + = -
  ...files(['+', '='], ['onTagByFilespec']),
  ...tree(['+', '='], ['onRefresh']),
  ...files(['-'], ['onUntagByFilespec']),
  ...tree(['-'], []),
  ...files(['*'], []),
  ...tree(['*'], ['onRefresh']),
  ...both(['f2'], ['onForceRefresh']),
  ...files(['`'], []),
  ...tree(['`'], ['onNextSibling']),
  // File operations
  ...both(['c', 'f5'], ['onCopy']),
  ...both(['f6'], ['onMove']),
  ...files(['m'], ['onMove']),
  ...tree(['m'], ['onMakeDir']),
  ...both(['d', 'f7'], ['onDelete']),
  ...both(['f8'], ['onPrune']),
  ...both(['f3', 'v'], ['onView']),
  // Sorting and filtering
  ...files(['s'], ['onSort']),
  ...tree(['s'], ['onShowallMode']),
  ...both(['S-s'], ['onSortDirection']),
  ...files(['f'], ['onFilespec']),
  ...tree(['f'], []),
  ...both(['C-f'], ['onToggleFilespec']),
  // Invert
  ...files(['i'], ['onInvertTag']),
  ...tree(['i'], []),
  // C-i never reaches the app from a terminal (it is Tab), so the dead
  // binding was dropped rather than rebound (D4).
  ...both(['C-i'], []), // changed by B6 (was ['onInvertAllTags'])
  // Rename / attributes / editor
  ...files(['n', 'r'], ['onRename']),
  ...tree(['n', 'r'], []),
  ...files(['a'], ['onAttributes']),
  ...tree(['a'], []),
  ...both(['e', 'f4'], ['onEditor']),
  // Help
  ...both(['?', 'f1'], ['onHelp']),
  ...both(['f10'], ['onQuickRef']),
  // Branch mode
  ...files(['b'], ['onBranchMode']),
  ...tree(['b'], []),
  // Global tag operations and pattern rename
  ...both(['C-t'], ['onTagAllGlobal']),
  ...both(['C-u'], ['onUntagAllGlobal']),
  ...both(['C-g'], ['onToggleTaggedOnly']),
  ...both(['C-n'], ['onPatternRename']),
  // Dedupe compare
  ...files(['C-d'], ['onDedupeCompare']),
  ...tree(['C-d'], []),
  // Speed nav: Shift+letter on the file pane (S-s, S-t, S-u are above)
  ...SPEED_NAV_LETTERS.flatMap((l) => [
    ...files([`S-${l}`], [`onSpeedNav:${l.toUpperCase()}`]),
    ...tree([`S-${l}`], []),
  ]),

  // Variants beyond the pane x key product: same keys, different fixture.
  {
    key: '\\', pane: 'files', label: 'in branch mode jumps to the parent of the highlighted file',
    setup: (f) => { f.state.listingMode = 'branch'; f.state.branchBasePath = f.T; },
    fired: ['onNavigate:$T/work'],
    changes: { listingMode: 'normal', branchBasePath: null },
  },
  {
    key: 'right', pane: 'files', label: 'on a directory navigates into it',
    setup: (f) => { f.state.selectedIndex = 0; },
    fired: ['onNavigate:$T/work/adir'],
  },
  {
    key: 'enter', pane: 'files', label: 'on a directory navigates into it',
    setup: (f) => { f.state.selectedIndex = 0; },
    fired: ['onNavigate:$T/work/adir'],
  },
  {
    key: 't', pane: 'files', label: 'on a directory does nothing',
    setup: (f) => { f.state.selectedIndex = 0; },
    fired: [],
  },
  {
    key: 'left', pane: 'tree', label: 'on an expanded node collapses it',
    setup: (f) => { f.treeSelected.value = 0; },
    fired: ['onRefresh'],
  },
  {
    key: '-', pane: 'tree', label: 'on an expanded node collapses it',
    setup: (f) => { f.treeSelected.value = 0; },
    fired: ['onRefresh'],
  },
  {
    key: '*', pane: 'tree', label: 'on an expanded node collapses it',
    setup: (f) => { f.treeSelected.value = 0; },
    fired: ['onRefresh'],
  },
  {
    key: 'enter', pane: 'tree', label: 'on a node without subdirectories selects it',
    setup: (f) => { f.treeSelected.value = 2; },
    fired: ['onTreeSelect:$T/sub2'],
  },
  {
    key: 'u', pane: 'files', label: 'untags the current tagged file and advances',
    setup: (f) => { f.state.taggedPaths.add(f.state.entries[1].path); },
    fired: ['onRefresh'], changes: { tagged: [], selectedIndex: 2 },
  },
  {
    key: 't', pane: 'files', label: 'in tagged-only view does not advance past the end',
    setup: (f) => { f.state.showTaggedOnly = true; f.state.taggedPaths.add(f.state.entries[1].path); },
    fired: ['onRefresh'], changes: { tagged: [], selectedIndex: 0 },
  },
  {
    key: 'left', pane: 'files', label: 'at the filesystem root does nothing',
    setup: (f) => { f.state.currentPath = '/'; },
    fired: [],
  },
];

describe('normal-mode key parity', () => {
  for (const row of ROWS) {
    const title = `${row.pane} pane: ${row.key}${row.label ? ` ${row.label}` : ''}`;
    test(title, async () => {
      const result = await run(row);
      expect(result.fired).toEqual(row.fired);
      expect(result.changes).toEqual(row.changes ?? {});
    });
  }
});

// --- Help drift guard -------------------------------------------------------
// help-pane's tables are prose written by hand; the keymap is what actually
// runs. Every key the help names must resolve to a keymap row in that pane,
// and every keymap row that claims a help entry must find it there.

const NAMED: Record<string, string> = {
  Up: 'up', Down: 'down', Left: 'left', Right: 'right', Enter: 'enter',
  Home: 'home', End: 'end', PgUp: 'pageup', PgDn: 'pagedown', Tab: 'tab',
};

/** 'Ctrl+T' -> ['C-t'], 'Up/k' -> ['up', 'k'], 'T' -> ['S-t'], 'Shift+A-Z' -> S-a..S-z. */
function helpKeyToBlessed(label: string): string[] {
  if (label === 'Shift+A-Z') return 'abcdefghijklmnopqrstuvwxyz'.split('').map((l) => `S-${l}`);
  return label.split('/').map((part) => {
    if (part.startsWith('Ctrl+')) return `C-${part.slice(5).toLowerCase()}`;
    if (NAMED[part]) return NAMED[part];
    if (/^F\d+$/.test(part)) return part.toLowerCase();
    if (/^[a-z]$/.test(part)) return part;
    if (/^[A-Z]$/.test(part)) return `S-${part.toLowerCase()}`;
    if (part.length === 1) return part; // punctuation
    throw new Error(`help key label not understood: ${label}`);
  });
}

describe('help matches the keymap', () => {
  const tables: Array<[string, Scope, HelpEntry[]]> = [
    ['file pane help', 'files', FILE_HELP],
    ['tree pane help', 'tree', TREE_HELP],
  ];

  for (const [name, pane, entries] of tables) {
    test(`every key in the ${name} resolves to a keymap row for that pane`, () => {
      const unbound: string[] = [];
      for (const e of entries) {
        for (const k of helpKeyToBlessed(e.key)) {
          if (!findBinding(k, pane as 'files' | 'tree')) unbound.push(`${e.key} -> ${k}`);
        }
      }
      expect(unbound).toEqual([]);
    });
  }

  test('every keymap row with a help label is documented in a table for its scope', () => {
    const files = new Set(FILE_HELP.map((e) => e.key));
    const tree = new Set(TREE_HELP.map((e) => e.key));
    const missing: string[] = [];
    for (const row of KEYMAP) {
      if (!row.help) continue;
      const found =
        row.scope === 'files' ? files.has(row.help)
        : row.scope === 'tree' ? tree.has(row.help)
        : files.has(row.help) || tree.has(row.help);
      if (!found) missing.push(`${row.scope}: ${row.help}`);
    }
    expect(missing).toEqual([]);
  });

  test('the help label of a row names that row\'s own keys', () => {
    const wrong: string[] = [];
    for (const row of KEYMAP) {
      if (!row.help) continue;
      const named = helpKeyToBlessed(row.help);
      if (!row.keys.some((k) => named.includes(k))) wrong.push(`${row.keys.join(',')} vs ${row.help}`);
    }
    expect(wrong).toEqual([]);
  });

  test('Ctrl+I is neither in a help table nor in the keymap', () => {
    const labels = [...FILE_HELP, ...TREE_HELP].map((e) => e.key.toLowerCase());
    expect(labels).not.toContain('ctrl+i');
    expect(KEYMAP.some((row) => row.keys.includes('C-i'))).toBe(false);
  });
});
