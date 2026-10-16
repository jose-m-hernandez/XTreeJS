// A real viewer on a headless screen, opened the way the app opens it
// (`onView` in src/app/commands.ts): load the file, build a ViewerState, show.
// Shared by the viewer parity, escaping and structural-gate tests.

import * as fs from 'fs';
import * as path from 'path';
import type blessed from 'neo-blessed';
import { createHeadlessScreen, flush, press, type HeadlessScreen } from './headless-screen.js';
import { createViewerPane, clearScrollCache, type ViewerPane } from '../../src/tui/viewer-pane.js';
import { createAppState, type AppState, type ViewerState } from '../../src/state/app-state.js';
import { viewFile } from '../../src/fs/view.js';

// The headless screen is 120x40. The viewer is: top bar on row 0, a bordered
// box on rows 1..38 (content rows 2..37, columns 1..118), bottom bar on row 39.
export const CONTENT_TOP = 2;
export const CONTENT_LEFT = 1;
export const CONTENT_WIDTH = 118;
export const VIEWPORT_HEIGHT = 36;

export interface Rig {
  h: HeadlessScreen;
  screen: blessed.Widgets.Screen;
  state: AppState;
  pane: ViewerPane;
  exits: { count: number };
  filePath: string;
  /** Press one key, then let async handlers settle. */
  key(name: string, opts?: { shift?: boolean }): Promise<void>;
  /** Press each key in turn. */
  keys(names: string[]): Promise<void>;
  destroy(): void;
}

export function freshViewerState(filePath: string, lines: string[]): ViewerState {
  return {
    filePath, lines, scrollPos: 0, totalLines: lines.length, viewerMode: 'text',
    searchQuery: '', searchMatches: [], currentMatch: -1, wordWrap: false, tabSize: 4,
    followMode: false, gatherStart: null, gatherEnd: null,
  };
}

function build(filePath: string, lines: string[]): Rig {
  clearScrollCache();
  const h = createHeadlessScreen();
  const state = createAppState(path.dirname(filePath));
  state.viewMode = 'viewer';
  const exits = { count: 0 };
  const pane = createViewerPane(h.screen, state, () => {
    exits.count++;
    state.viewMode = 'normal';
    state.viewerState = null;
  });
  state.viewerState = freshViewerState(filePath, lines);
  pane.show(lines, filePath);
  const rig: Rig = {
    h, screen: h.screen, state, pane, exits, filePath,
    async key(name, opts) {
      press(h.screen, name, opts);
      await flush(8);
    },
    async keys(names) {
      for (const n of names) await rig.key(n);
    },
    destroy() {
      if (pane.isVisible()) pane.hide();
      h.destroy();
    },
  };
  return rig;
}

/** Open a real file (read with `viewFile`, as the app does). */
export async function openFile(filePath: string): Promise<Rig> {
  const result = await viewFile(filePath, 120, 40);
  return build(filePath, result.lines);
}

/** Open synthetic lines under a made-up path (no file behind it). */
export function openLines(lines: string[], filePath = '/synthetic/file.txt'): Rig {
  return build(filePath, lines);
}

const cells = (screen: blessed.Widgets.Screen, row: number): any[] => (screen as any).lines[row] ?? [];

/** One screen row as drawn, columns [left, left+width). */
export function rowText(screen: blessed.Widgets.Screen, row: number, left = 0, width = 120): string {
  return cells(screen, row).slice(left, left + width).map((c) => c[1]).join('');
}

/** The first `n` rows inside the viewer's border, right-trimmed. */
export function contentRows(screen: blessed.Widgets.Screen, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(rowText(screen, CONTENT_TOP + i, CONTENT_LEFT, CONTENT_WIDTH).trimEnd());
  }
  return out;
}

/** The viewer's top bar (row 0), right-trimmed. */
export function topBarText(screen: blessed.Widgets.Screen): string {
  return rowText(screen, 0).trimEnd();
}

/** Run-length attribute signature of a content row's visible text, e.g. "7x3,12x5". */
export function rowAttrs(screen: blessed.Widgets.Screen, i: number): string {
  const text = rowText(screen, CONTENT_TOP + i, CONTENT_LEFT, CONTENT_WIDTH).trimEnd();
  const c = cells(screen, CONTENT_TOP + i).slice(CONTENT_LEFT, CONTENT_LEFT + text.length);
  const runs: string[] = [];
  let prev: number | null = null;
  let len = 0;
  for (const cell of c) {
    if (cell[0] === prev) len++;
    else {
      if (prev !== null) runs.push(`${prev}x${len}`);
      prev = cell[0];
      len = 1;
    }
  }
  if (prev !== null) runs.push(`${prev}x${len}`);
  return runs.join(',');
}

/** Write the parity fixture: tabs, one long line, repeated words, 90 lines. */
export function writeParityFixture(dir: string): string {
  const lines: string[] = [];
  for (let i = 1; i <= 90; i++) {
    if (i === 12) {
      lines.push(`line ${i}: ` + 'wide '.repeat(60) + 'END');
    } else if (i % 5 === 0) {
      lines.push(`line ${i}:\tcol1\tcol2\talpha beta`);
    } else if (i % 7 === 0) {
      lines.push(`line ${i}: the quick brown fox, the lazy dog`);
    } else if (i % 11 === 0) {
      lines.push(`line ${i}: foo bar foo bar foo`);
    } else {
      lines.push(`line ${i}: plain text number ${i}`);
    }
  }
  const file = path.join(dir, 'fixture.txt');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
