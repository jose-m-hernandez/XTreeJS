// Phase B-2 behaviour fixes, each written to fail on the B-1 structure first:
// B10 tree cursor in state, B11 stale-load guard, B12 one render per refresh,
// F1 blessed tags in file names are shown literally.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { createHeadlessScreen, flush, press, screenText, type HeadlessScreen } from '../helpers/headless-screen.js';
import { createApp, type App } from '../../src/app/app.js';
import { createCommands } from '../../src/app/commands.js';
import { createPanel } from '../../src/app/panel.js';
import { setupInput } from '../../src/tui/input.js';
import { showConfirm, showPrompt } from '../../src/tui/prompt.js';
import { detectTools } from '../../src/fs/detect-tools.js';
import type { FileEntry } from '../../src/fs/list.js';

setDefaultTimeout(30000); // createTreeState walks from the volume root

let tmp: string;
let h: HeadlessScreen | null = null;

beforeEach(async () => {
  await detectTools();
  // Shallow and small: the tree is rooted at '/', so a directory under the
  // per-user os.tmpdir() would make every createApp walk a very wide path.
  fs.mkdirSync('/tmp/claude', { recursive: true });
  tmp = fs.realpathSync(fs.mkdtempSync('/tmp/claude/xtree-pb-'));
});

afterEach(() => {
  h?.destroy();
  h = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The real App wired exactly as index.ts does, started in `startPath`. */
async function makeApp(startPath: string): Promise<App> {
  h = createHeadlessScreen();
  const app = await createApp(h.screen, startPath);
  const p = app.activePanel();
  setupInput(h.screen, p.state, p.treeState, p.treePane, createCommands(app));
  await p.loadDirectory(startPath);
  p.state.focusPane = 'tree';
  p.treePane.widget.focus();
  app.refreshUI();
  return app;
}

function fakeEntry(dir: string, name: string): FileEntry {
  return {
    name,
    path: path.join(dir, name),
    isDirectory: false,
    isSymlink: false,
    isExecutable: false,
    size: 1,
    mtime: new Date(0),
  };
}

describe('B10: the tree cursor lives in state', () => {
  test('a full refreshUI does not snap the cursor back to currentPath', async () => {
    for (const d of ['a', 'b', 'c']) fs.mkdirSync(path.join(tmp, d));
    const app = await makeApp(tmp);
    const p = app.activePanel();
    const start = p.treeState.flatNodes.findIndex((n) => n.path === tmp);
    expect(start).toBeGreaterThanOrEqual(0);
    // tmp is expanded, so its children a, b, c follow it in the flat list.
    expect(p.treeState.flatNodes[start + 2].name).toBe('b');

    press(h!.screen, 'down');
    press(h!.screen, 'down');
    await flush();
    app.refreshUI(); // what computeTreeStats and every other refresh does

    expect(p.treePane.getSelectedIndex()).toBe(start + 2);
    expect(p.treeState.selectedIndex).toBe(start + 2);
    // navigation did not run: the file list is still tmp's
    expect(p.state.currentPath).toBe(tmp);
  });

  test('navigating moves the cursor to the new current path', async () => {
    fs.mkdirSync(path.join(tmp, 'a'));
    fs.mkdirSync(path.join(tmp, 'b'));
    const app = await makeApp(tmp);
    const p = app.activePanel();
    press(h!.screen, 'down');
    await flush();
    press(h!.screen, 'enter'); // open the node under the cursor
    await flush(40);
    const idx = p.treeState.flatNodes.findIndex((n) => n.path === p.state.currentPath);
    expect(p.state.currentPath).toBe(path.join(tmp, 'a'));
    expect(p.treeState.selectedIndex).toBe(idx);
  });
});

describe('B10: tree cursor-up', () => {
  test('up moves the cursor one row; at the top it stays', async () => {
    for (const d of ['a', 'b', 'c']) fs.mkdirSync(path.join(tmp, d));
    const app = await makeApp(tmp);
    const p = app.activePanel();
    press(h!.screen, 'down');
    press(h!.screen, 'down');
    await flush();
    const k = p.treeState.selectedIndex;
    expect(k).toBeGreaterThan(0);
    press(h!.screen, 'up');
    await flush();
    expect(p.treeState.selectedIndex).toBe(k - 1);
    p.treeState.selectedIndex = 0;
    app.refreshUI();
    press(h!.screen, 'up');
    await flush();
    expect(p.treeState.selectedIndex).toBe(0);
  });
});

describe('B11: a stale directory load is dropped', () => {
  const delays: Record<string, number> = {};
  const lister = (dir: string) =>
    new Promise<FileEntry[]>((resolve) =>
      setTimeout(() => resolve([fakeEntry(dir, `from-${path.basename(dir)}`)]), delays[dir] ?? 0)
    );

  test('two overlapping loadDirectory calls, the first resolving last', async () => {
    h = createHeadlessScreen();
    const A = path.join(tmp, 'A');
    const B = path.join(tmp, 'B');
    delays[A] = 80;
    delays[B] = 5;
    const p = await createPanel(h.screen, tmp, lister);
    await Promise.all([p.loadDirectory(A), p.loadDirectory(B)]);
    expect(p.state.currentPath).toBe(B);
    expect(p.state.entries.map((e) => e.name)).toEqual(['from-B']);
  });

  test('a slow reloadEntries does not overwrite a later loadDirectory', async () => {
    h = createHeadlessScreen();
    const A = path.join(tmp, 'A');
    const B = path.join(tmp, 'B');
    delays[A] = 80;
    delays[B] = 5;
    const p = await createPanel(h.screen, A, lister);
    const slow = p.reloadEntries(); // lists A
    await p.loadDirectory(B);
    await slow;
    expect(p.state.entries.map((e) => e.name)).toEqual(['from-B']);
  });
});

describe('B12: one render per refresh', () => {
  test('refreshUI renders exactly once in every display mode and focus', async () => {
    fs.mkdirSync(path.join(tmp, 'a'));
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'x');
    const app = await makeApp(tmp);
    const p = app.activePanel();
    let renders = 0;
    const real = h!.screen.render.bind(h!.screen);
    h!.screen.render = () => {
      renders++;
      real();
    };
    const counts: Record<string, number> = {};
    for (const mode of ['dir', 'small', 'expanded'] as const) {
      for (const focus of ['tree', 'files'] as const) {
        p.state.displayMode = mode;
        p.state.focusPane = focus;
        renders = 0;
        app.refreshUI();
        counts[`${mode}/${focus}`] = renders;
      }
    }
    expect(counts).toEqual({
      'dir/tree': 1,
      'dir/files': 1,
      'small/tree': 1,
      'small/files': 1,
      'expanded/tree': 1,
      'expanded/files': 1,
    });
  });
});

/** Rendered text of one widget's region only, after a render. */
function regionText(screen: HeadlessScreen['screen'], w: { aleft: number; atop: number; width: number; height: number }): string[] {
  screen.render();
  const rows: string[] = [];
  for (let r = w.atop; r < w.atop + w.height; r++) {
    rows.push((screen as any).lines[r].map((c: any) => c[1]).join('').slice(w.aleft, w.aleft + w.width));
  }
  return rows;
}

describe('F1: tag-like text in names is shown literally', () => {
  test('file pane row', async () => {
    const dir = path.join(tmp, 'plain');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '{bold}x.txt'), 'x');
    const app = await makeApp(dir);
    expect(screenText(h!.screen).some((r) => r.includes('{bold}x.txt'))).toBe(true);
  });

  test('tree row', async () => {
    fs.mkdirSync(path.join(tmp, '{bold}d'));
    const app = await makeApp(tmp);
    // The file pane lists the same dir; read the tree pane's region only.
    const w = app.activePanel().treePane.widget as any;
    expect(regionText(h!.screen, w).some((r) => r.includes('{bold}d'))).toBe(true);
  });

  test('stats pane current directory', async () => {
    const dir = path.join(tmp, '{bold}d');
    fs.mkdirSync(dir);
    const app = await makeApp(dir);
    app.activePanel().state.displayMode = 'dir';
    app.refreshUI();
    const w = app.statsPane.widget as any;
    expect(regionText(h!.screen, w).some((r) => r.includes('{bold}d'))).toBe(true);
  });

  test('status bar path', async () => {
    const dir = path.join(tmp, '{bold}d');
    fs.mkdirSync(dir);
    await makeApp(dir);
    expect(screenText(h!.screen)[0]).toContain('{bold}d');
  });

  test('confirm and prompt text that embeds a name', async () => {
    h = createHeadlessScreen();
    // Both boxes sit at the centre of the screen: read each before the next.
    void showConfirm(h.screen, 'Delete 1 item(s)? ({bold}x.txt)');
    await flush();
    expect(screenText(h.screen).some((r) => r.includes('({bold}x.txt)'))).toBe(true);
    press(h.screen, 'n'); // answer it, closing the box
    await flush();
    void showPrompt(h.screen, 'Rename {bold}x.txt to:', '');
    await flush();
    expect(screenText(h.screen).some((r) => r.includes('Rename {bold}x.txt to:'))).toBe(true);
  });
});
