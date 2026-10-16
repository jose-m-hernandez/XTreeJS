// One test per key-routing bug (B1-B9), each asserting the CORRECT behaviour.
// Before the key router these all failed: a key that closed a modal also ran
// its normal-mode action, because neo-blessed emits 'keypress' and then
// 'key <name>' for the same keystroke and nothing told the second one that a
// modal had just consumed it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHeadlessScreen, flush, press, screenText, type HeadlessScreen } from '../helpers/headless-screen.js';
import { setupInput, type InputCallbacks } from '../../src/tui/input.js';
import type { TreePane } from '../../src/tui/tree-pane.js';
import { createAppState, type AppState } from '../../src/state/app-state.js';
import type { TreeState } from '../../src/state/tree-state.js';
import type { FileEntry } from '../../src/fs/list.js';
import type { FileAttributes } from '../../src/fs/operations.js';
import { viewFile } from '../../src/fs/view.js';
import { createViewerPane, type ViewerPane } from '../../src/tui/viewer-pane.js';
import { showHelp, showQuickRef } from '../../src/tui/help-pane.js';
import { showAttributes, showConfirm, showPrompt, addToHistory, clearAllHistory } from '../../src/tui/prompt.js';
import { showTextReport } from '../../src/tui/dedupe-pane.js';

interface App {
  h: HeadlessScreen;
  state: AppState;
  calls: string[];
  errors: string[];
  viewerPane: ViewerPane;
}

let tmp: string;
let app: App;

function entry(name: string, isDirectory = false): FileEntry {
  return {
    name,
    path: path.join(tmp, name),
    isDirectory,
    isSymlink: false,
    isExecutable: false,
    size: 1,
    mtime: new Date(0),
  };
}

/** Real setupInput and viewer pane, with every callback recorded by name. */
function makeApp(overrides: Partial<InputCallbacks> = {}): App {
  const h = createHeadlessScreen();
  const state = createAppState(tmp);
  state.entries = [entry('a.txt'), entry('b.txt'), entry('c.txt')];
  state.selectedIndex = 0;

  const calls: string[] = [];
  const errors: string[] = [];
  const rec = (name: string) => () => {
    calls.push(name);
  };
  const node = { path: tmp, name: 'tmp', depth: 0, expanded: true, hasSubdirs: false, children: [], isLast: true };
  const treeState: TreeState = { root: node, flatNodes: [node], selectedIndex: 0 };
  const treePane = {
    widget: { up() {}, down() {}, select() {} },
    getSelectedIndex: () => 0,
  } as unknown as TreePane;

  const names = [
    'onNavigate', 'onRefresh', 'onQuit', 'onCopy', 'onMove', 'onDelete', 'onPrune', 'onView',
    'onTabSwitch', 'onTreeSelect', 'onSort', 'onSortDirection', 'onFilespec', 'onToggleFilespec',
    'onInvertTag', 'onSpeedNav', 'onRename', 'onMakeDir', 'onAttributes',
    'onEditor', 'onDeepDive', 'onNextSibling', 'onTreeRoot', 'onDisplayCycle',
    'onForceRefresh', 'onHelp', 'onQuickRef', 'onBranchMode', 'onShowallMode', 'onTagByFilespec',
    'onUntagByFilespec', 'onTagAllGlobal', 'onUntagAllGlobal', 'onToggleTaggedOnly',
    'onPatternRename', 'onDedupeCompare',
  ] as const;
  const callbacks = Object.fromEntries(names.map((n) => [n, rec(n)])) as unknown as InputCallbacks;
  Object.assign(callbacks, overrides);

  const viewerPane = createViewerPane(h.screen, state, () => {
    state.viewMode = 'normal';
    state.viewerState = null;
  });
  setupInput(h.screen, state, treeState, treePane, callbacks, (msg: string) => errors.push(msg));
  return { h, state, calls, errors, viewerPane };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xtree-routing-'));
  clearAllHistory();
  app = makeApp();
});

afterEach(() => {
  app.h.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('B1: q in the viewer', () => {
  test('closes the viewer and does not quit the app', async () => {
    const file = path.join(tmp, 'notes.txt');
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    const result = await viewFile(file, 120, 40);
    app.state.viewMode = 'viewer';
    app.state.viewerState = {
      filePath: file, lines: result.lines, scrollPos: 0, totalLines: result.totalLines,
      viewerMode: 'text', searchQuery: '', searchMatches: [], currentMatch: -1,
      wordWrap: false, tabSize: 4, followMode: false, gatherStart: null, gatherEnd: null,
    };
    app.viewerPane.show(result.lines, file);
    expect(app.viewerPane.isVisible()).toBe(true);

    press(app.h.screen, 'q');
    await flush();

    expect(app.viewerPane.isVisible()).toBe(false);
    expect(app.calls).not.toContain('onQuit');
  });
});

describe('B2: q in Help', () => {
  test('closes Help and does not quit the app', async () => {
    const closed = showHelp(app.h.screen, 'files').then(() => true);
    press(app.h.screen, 'q');
    expect(await closed).toBe(true);
    await flush();
    expect(app.calls).not.toContain('onQuit');
  });
});

describe('B3: n in a confirm', () => {
  test('answers no and does not open Rename', async () => {
    const answer = showConfirm(app.h.screen, 'Delete 1 file?');
    press(app.h.screen, 'n');
    expect(await answer).toBe(false);
    await flush();
    expect(app.calls).not.toContain('onRename');
  });
});

describe('B4: keys in the attributes dialog', () => {
  const attrs: FileAttributes = {
    permissions: '644', owner: 501, group: 20, mode: 0o100644, size: 1,
    mtime: new Date(0), atime: new Date(0), isDirectory: false, isSymlink: false,
  };

  test('c asks to change permissions and does not also open Copy', async () => {
    const result = showAttributes(app.h.screen, 'a.txt', attrs);
    press(app.h.screen, 'c');
    expect(await result).toBe('chmod');
    await flush();
    expect(app.calls).not.toContain('onCopy');
  });

  test('q closes the dialog and does not quit the app', async () => {
    const result = showAttributes(app.h.screen, 'a.txt', attrs);
    press(app.h.screen, 'q');
    expect(await result).toBe(null);
    await flush();
    expect(app.calls).not.toContain('onQuit');
  });
});

describe('B5: quick reference and Help scrolling', () => {
  test('the key that closes the quick reference does not run its normal action', async () => {
    const closed = showQuickRef(app.h.screen).then(() => true);
    press(app.h.screen, 'd');
    expect(await closed).toBe(true);
    await flush();
    expect(app.calls).not.toContain('onDelete');
  });

  test('j in Help scrolls Help and does not move the file cursor', async () => {
    const closed = showHelp(app.h.screen, 'files');
    press(app.h.screen, 'j');
    await flush();
    expect(app.state.selectedIndex).toBe(0);
    press(app.h.screen, 'escape');
    await closed;
  });
});

describe('B6: Ctrl+I invert-all', () => {
  test('Help no longer advertises a key that cannot be pressed', async () => {
    const closed = showHelp(app.h.screen, 'files');
    const text = screenText(app.h.screen).join('\n');
    expect(text).toContain('Invert tag on current file');
    expect(text).not.toContain('Invert all');
    press(app.h.screen, 'escape');
    await closed;
  });

  test('the quick reference no longer advertises it either', async () => {
    const closed = showQuickRef(app.h.screen);
    const text = screenText(app.h.screen).join('\n');
    expect(text).toContain('Tagging');
    expect(text).not.toContain('Invert all');
    press(app.h.screen, 'escape');
    await closed;
  });
});

describe('B7: prompt history keys', () => {
  test('Up recalls the most recent history entry', async () => {
    addToHistory('t', 'alpha');
    addToHistory('t', 'beta');
    const result = showPrompt(app.h.screen, 'Name:', '', 't');
    press(app.h.screen, 'up');
    await flush();
    const text = screenText(app.h.screen).join('\n');
    expect(text).toContain('beta');
    expect(text).not.toContain('alpha');
    press(app.h.screen, 'up');
    await flush();
    expect(screenText(app.h.screen).join('\n')).toContain('alpha');
    press(app.h.screen, 'escape');
    expect(await result).toBe(null);
  });
});

describe('B8: a rejecting callback', () => {
  test('is reported through the error setter and is not an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      app.h.destroy();
      app = makeApp({
        onCopy: async () => {
          throw new Error('copy exploded');
        },
      });
      press(app.h.screen, 'c');
      await flush(50);
      expect(app.errors.length).toBe(1);
      expect(app.errors[0]).toContain('copy exploded');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('B9: the dedupe report modal', () => {
  test('q closes the report and does not quit the app', async () => {
    const closed = showTextReport(app.h.screen, 'Report', ['one', 'two']);
    press(app.h.screen, 'q');
    await closed;
    await flush();
    expect(app.calls).not.toContain('onQuit');
  });

  test('j scrolls the report and does not move the file cursor', async () => {
    const closed = showTextReport(app.h.screen, 'Report', Array.from({ length: 80 }, (_, i) => `line ${i}`));
    press(app.h.screen, 'j');
    await flush();
    expect(app.state.selectedIndex).toBe(0);
    press(app.h.screen, 'escape');
    await closed;
  });
});

describe('router layers', () => {
  test('Ctrl+C still quits while a modal is open', async () => {
    const closed = showHelp(app.h.screen, 'files');
    press(app.h.screen, 'c', { ctrl: true });
    await flush();
    expect(app.calls).toEqual(['onQuit']);
    press(app.h.screen, 'escape');
    await closed;
  });

  test('a prompt opened from the viewer closes alone, leaving the viewer for the next key', async () => {
    const file = path.join(tmp, 'notes.txt');
    fs.writeFileSync(file, 'one\ntwo\n');
    const result = await viewFile(file, 120, 40);
    app.state.viewMode = 'viewer';
    app.state.viewerState = {
      filePath: file, lines: result.lines, scrollPos: 0, totalLines: result.totalLines,
      viewerMode: 'text', searchQuery: '', searchMatches: [], currentMatch: -1,
      wordWrap: false, tabSize: 4, followMode: false, gatherStart: null, gatherEnd: null,
    };
    app.viewerPane.show(result.lines, file);

    press(app.h.screen, 's'); // search prompt opens over the viewer
    await flush();
    press(app.h.screen, 'escape'); // closes the prompt only
    await flush();
    expect(app.viewerPane.isVisible()).toBe(true);

    press(app.h.screen, 'q'); // now the viewer is on top again
    await flush();
    expect(app.viewerPane.isVisible()).toBe(false);
    expect(app.calls).toEqual([]);
  });

  test('keys reach the keymap again once every modal has closed', async () => {
    const closed = showHelp(app.h.screen, 'files');
    press(app.h.screen, 'escape');
    await closed;
    press(app.h.screen, 'q');
    await flush();
    expect(app.calls).toEqual(['onQuit']);
  });
});
