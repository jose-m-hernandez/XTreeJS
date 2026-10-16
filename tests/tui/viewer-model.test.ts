// C-MODEL: unit tests for the viewer model (src/tui/viewer-model.ts). No screen
// here; the model has no blessed in it.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as view from '../../src/fs/view.js';
import { arraySource, createViewerModel, defaultViewerState, hexSource } from '../../src/tui/viewer-model.js';

const tabbed = (n: number): string[] => Array.from({ length: n }, (_, i) => `row\t${i}`);
const model = (lines: string[]) => createViewerModel(defaultViewerState('/m/file.txt', lines));

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});
const spy = <K extends 'expandTabs' | 'wrapLines' | 'hexLine'>(name: K) => {
  const s = spyOn(view, name);
  spies.push(s);
  return s;
};

describe('derived-lines cache', () => {
  test('scrolling reuses it: zero expandTabs/wrapLines calls', () => {
    const m = model(tabbed(500));
    const tabs = spy('expandTabs');
    const wraps = spy('wrapLines');
    m.window(20);
    expect(tabs.mock.calls.length).toBe(500); // built once, on first use
    tabs.mockClear();
    m.scrollDown(1, 20);
    m.window(20);
    m.scrollDown(20, 20);
    m.window(20);
    m.scrollToBottom(20);
    m.window(20);
    m.scrollUp(5);
    m.window(20);
    m.scrollToTop();
    m.window(20);
    m.displayLength();
    expect(tabs.mock.calls.length).toBe(0);
    expect(wraps.mock.calls.length).toBe(0);
  });

  test('a tab size change invalidates it', () => {
    const m = model(tabbed(50));
    m.window(10);
    const tabs = spy('expandTabs');
    m.toggleTabSize();
    expect(m.state.tabSize).toBe(8);
    m.window(10);
    expect(tabs.mock.calls.length).toBe(50);
    expect(m.window(10).rows[0].text).toBe('row     0');
  });

  test('toggling wrap invalidates it, and wrap uses the width', () => {
    const m = model(['x'.repeat(100), 'short']);
    m.window(10);
    const wraps = spy('wrapLines');
    m.toggleWrap();
    m.setWidth(40);
    expect(m.displayLength()).toBe(4); // 40 + 40 + 20, and 'short'
    expect(wraps.mock.calls.length).toBe(1);
    m.window(10);
    expect(wraps.mock.calls.length).toBe(1);
    m.toggleWrap();
    expect(m.displayLength()).toBe(2);
  });

  test('a width change invalidates it only while wrap is on', () => {
    const m = model(['x'.repeat(100)]);
    m.window(10);
    const wraps = spy('wrapLines');
    const tabs = spy('expandTabs');
    m.setWidth(60); // wrap off: the width does not matter
    m.window(10);
    expect(tabs.mock.calls.length + wraps.mock.calls.length).toBe(0);
    m.toggleWrap();
    m.setWidth(50);
    expect(m.displayLength()).toBe(2);
    m.setWidth(30);
    expect(m.displayLength()).toBe(4);
    expect(wraps.mock.calls.length).toBe(2);
  });

  test('wrap never goes narrower than 20 columns', () => {
    const m = model(['x'.repeat(40)]);
    m.toggleWrap();
    m.setWidth(3);
    expect(m.displayLength()).toBe(2);
  });

  test('new lines invalidate it', () => {
    const m = model(tabbed(5));
    m.window(10);
    const tabs = spy('expandTabs');
    m.loadText(tabbed(7));
    expect(m.displayLength()).toBe(7);
    expect(tabs.mock.calls.length).toBe(7);
  });
});

describe('window', () => {
  test('returns at most height rows, at 200,000 lines too', () => {
    const m = model(tabbed(200_000));
    m.scrollToBottom(36);
    expect(m.window(36).rows.length).toBe(36);
    m.scrollToTop();
    const w = m.window(36);
    expect(w.rows.length).toBe(36);
    expect(w.rows[0]).toEqual({ index: 0, number: 1, text: 'row 0', match: 'none', gathered: false });
    expect(w.displayLength).toBe(200_000);
    expect(w.totalDigits).toBe(6);
  });

  test('is short near the end and empty past it', () => {
    const m = model(['a', 'b', 'c']);
    m.state.scrollPos = 2;
    expect(m.window(10).rows.map((r) => r.text)).toEqual(['c']);
    m.state.scrollPos = 9;
    expect(m.window(10).rows).toEqual([]);
  });

  test('scrolling stays inside the raw lines', () => {
    const m = model(tabbed(100));
    m.scrollDown(1000, 30);
    expect(m.state.scrollPos).toBe(70);
    m.scrollUp(1000);
    expect(m.state.scrollPos).toBe(0);
    m.scrollToBottom(30);
    expect(m.state.scrollPos).toBe(70);
    m.loadText(['only']);
    m.scrollDown(5, 30);
    expect(m.state.scrollPos).toBe(0);
  });
});

describe('search', () => {
  const lines = ['alpha', 'beta', 'Alpha beta', 'gamma', 'beta again'];

  test('finds matches case-insensitively and jumps to the first', () => {
    const m = model(lines);
    m.search('ALPHA');
    expect(m.state.searchMatches).toEqual([0, 2]);
    expect(m.state.currentMatch).toBe(0);
    expect(m.state.scrollPos).toBe(0);
    m.search('beta');
    expect(m.state.searchMatches).toEqual([1, 2, 4]);
    expect(m.state.scrollPos).toBe(1);
  });

  test('next wraps around past the last match', () => {
    const m = model(lines);
    m.search('beta');
    m.nextMatch();
    m.nextMatch();
    expect([m.state.currentMatch, m.state.scrollPos]).toEqual([2, 4]);
    m.nextMatch();
    expect([m.state.currentMatch, m.state.scrollPos]).toEqual([0, 1]);
  });

  test('previous wraps around before the first match', () => {
    const m = model(lines);
    m.search('beta');
    m.prevMatch();
    expect([m.state.currentMatch, m.state.scrollPos]).toEqual([2, 4]);
    m.prevMatch();
    expect([m.state.currentMatch, m.state.scrollPos]).toEqual([1, 2]);
  });

  test('no match leaves the position alone and next/prev do nothing', () => {
    const m = model(lines);
    m.state.scrollPos = 3;
    m.search('zzz');
    expect(m.state.searchMatches).toEqual([]);
    expect(m.state.currentMatch).toBe(-1);
    m.nextMatch();
    m.prevMatch();
    expect(m.state.scrollPos).toBe(3);
  });

  test('marks matches in the window, the current one apart', () => {
    const m = model(lines);
    m.search('beta');
    m.nextMatch();
    m.scrollToTop();
    expect(m.window(5).rows.map((r) => r.match)).toEqual(['none', 'match', 'current', 'none', 'match']);
  });

  test('switching mode drops the search', () => {
    const m = model(lines);
    m.search('beta');
    m.setMode('ascii');
    expect(m.state).toMatchObject({ viewerMode: 'ascii', searchQuery: '', searchMatches: [], currentMatch: -1 });
  });
});

describe('gather', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);

  test('the second press returns the range from start to the window bottom', () => {
    const m = model(lines);
    m.state.scrollPos = 5;
    expect(m.gather(4)).toBeNull();
    expect(m.state.gatherStart).toBe(5);
    expect(m.isGathering()).toBe(true);
    m.scrollDown(10, 4);
    expect(m.gather(4)).toBe(['l5', 'l6', 'l7', 'l8', 'l9', 'l10', 'l11', 'l12', 'l13', 'l14', 'l15', 'l16', 'l17', 'l18'].join('\n'));
    expect(m.state.gatherEnd).toBe(18);
    m.clearGather();
    expect(m.state).toMatchObject({ gatherStart: null, gatherEnd: null });
    expect(m.isGathering()).toBe(false);
  });

  test('the range is ordered when the end is above the start', () => {
    const m = model(lines);
    m.state.scrollPos = 20;
    m.gather(3);
    m.state.scrollPos = 2;
    expect(m.gather(3)).toBe(lines.slice(4, 21).join('\n')); // end = 2 + 3 - 1 = 4
    expect([m.state.gatherStart, m.state.gatherEnd]).toEqual([20, 4]);
  });

  test('the range stops at the last line', () => {
    const m = model(lines);
    m.state.scrollPos = 27;
    m.gather(10);
    expect(m.gather(10)).toBe(['l27', 'l28', 'l29'].join('\n'));
  });

  test('a completed range is marked in the window', () => {
    const m = model(lines);
    m.gather(3);
    m.state.scrollPos = 0;
    m.gather(3);
    expect(m.window(5).rows.map((r) => r.gathered)).toEqual([true, true, true, false, false]);
  });
});

describe('hex', () => {
  // Expected values taken from viewFileHex as it was before the split.
  const bytes = Buffer.concat([
    Buffer.from('Hello, World!\t{bold}\n'),
    Buffer.from([0, 1, 0x1f, 0x20, 0x7e, 0x7f, 0x80, 0xff, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48]),
  ]);
  const EXPECTED = [
    '00000000  48 65 6C 6C 6F 2C 20 57 6F 72 6C 64 21 09 7B 62  |Hello, World!.{b|',
    '00000010  6F 6C 64 7D 0A 00 01 1F 20 7E 7F 80 FF 41 42 43  |old}.... ~...ABC|',
    '00000020  44 45 46 47 48                                   |DEFGH|',
  ];

  test('the page builder gives the literal viewFileHex gave', () => {
    const src = hexSource(bytes);
    expect(src.length).toBe(3);
    expect(src.slice(0, 3)).toEqual(EXPECTED);
    expect(src.toArray()).toEqual(EXPECTED);
    expect(src.at(1)).toBe(EXPECTED[1]);
  });

  test('and agrees with viewFileHex for the same bytes, at every length', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtreejs-hex-'));
    try {
      for (const n of [0, 1, 15, 16, 17, 31, 32, 33, 200]) {
        const buf = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256));
        const file = path.join(dir, `b${n}.bin`);
        fs.writeFileSync(file, buf);
        const old = await view.viewFileHex(file);
        const src = hexSource(buf);
        expect(src.toArray()).toEqual(old.lines);
        expect(src.length).toBe(old.totalLines);
        expect(src.joinedLength()).toBe(old.lines.join('\n').length);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a window builds only its own lines', () => {
    const m = model([]);
    m.loadHex(Buffer.alloc(16 * 100_000, 0x41));
    expect(m.state.totalLines).toBe(100_000);
    const hexLine = spy('hexLine');
    m.window(36);
    expect(hexLine.mock.calls.length).toBe(36);
    hexLine.mockClear();
    m.scrollDown(1, 36);
    m.window(36);
    expect(hexLine.mock.calls.length).toBe(36);
    expect(m.sizeChars()).toBe(100_000 * 77 + 99_999);
  });

  test('state.lines still reads as the dump', () => {
    const m = model(['text']);
    m.loadHex(bytes);
    expect(m.state.lines).toEqual(EXPECTED);
    expect(m.state.totalLines).toBe(3);
    m.loadText(['back']);
    expect(m.state.lines).toEqual(['back']);
  });

  test('search runs over the dump lines', () => {
    const m = model([]);
    m.loadHex(bytes);
    m.search('|old}');
    expect(m.state.searchMatches).toEqual([1]);
  });

  test('wrap narrower than a dump line wraps it; otherwise the dump is shown as is', () => {
    const m = model([]);
    m.loadHex(bytes);
    m.toggleWrap();
    m.setWidth(200);
    expect(m.displayLength()).toBe(3);
    m.setWidth(40);
    expect(m.displayLength()).toBe(6);
  });
});

describe('the model is pure', () => {
  test('viewer-model.ts does not import blessed', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../../src/tui/viewer-model.ts'), 'utf8');
    expect(src).not.toMatch(/^import .*blessed/m);
  });

  test('arraySource sizes', () => {
    expect(arraySource([]).joinedLength()).toBe(0);
    expect(arraySource(['']).joinedLength()).toBe(0);
    expect(arraySource(['ab', 'c']).joinedLength()).toBe(4);
  });

  test('the shared state is the model state', () => {
    const state = defaultViewerState('/m/f', ['a', 'b']);
    const m = createViewerModel(state);
    m.scrollDown(1, 1);
    expect(state.scrollPos).toBe(1);
    expect(m.state).toBe(state);
    expect(state.lines).toEqual(['a', 'b']);
  });
});
