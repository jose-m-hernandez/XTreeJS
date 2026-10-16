// C1: characterization of the viewer, written against the unmodified source and
// kept green through the viewer split. Each row opens a fresh viewer on the
// same fixture, presses a sequence of keys, and records what is observable:
// the viewer state the app owns (`AppState.viewerState`), the first three
// rendered content rows (text and a run-length of cell attributes, so search
// and gather highlighting count), the top and bottom bars, and what gather
// would have put on the clipboard.
//
// Instruments, so the table means what it says:
//  - Rendered text is read from `screen.lines`, restricted to the viewer's own
//    region (never `getLines()` or `stripTags`, which would hide a markup bug).
//  - The search prompt is typed into for real (`s`, the query, Enter).
//  - `pbcopy` is not run: `Bun.spawn` is spied for the length of each row,
//    because Bun resolves a spawned command's PATH once at startup, so a PATH
//    shim set from a test is never seen. The spy records the bytes written.
//  - Follow mode's one-second timer is not waited for: `setInterval` is
//    swapped for a capturing stub for the single `f` keypress, and the
//    captured callback is called by hand (step `tick`).
//
// Regenerating: `PARITY_DUMP=/path/out.json bun test tests/tui/viewer-parity.test.ts`
// writes the observed table instead of asserting it. Review the diff against
// EXPECTED by hand before pasting; a row that moves is a behaviour change.
//
// A row marked `// changed by C-F1` is one whose expected value moved when
// content and file names started being escaped. No fixture line here contains
// a brace, so none is marked.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { flush, press } from '../helpers/headless-screen.js';
import {
  contentRows, openFile, rowAttrs, rowText, topBarText, writeParityFixture, type Rig,
} from '../helpers/viewer-harness.js';
import { setCachedToolsForTesting, getCachedTools } from '../../src/fs/detect-tools.js';

interface Snap {
  visible: boolean;
  exits: number;
  vs: null | {
    scrollPos: number; mode: string; query: string; matches: number[]; current: number;
    wrap: boolean; tab: number; follow: boolean; gStart: number | null; gEnd: number | null;
    total: number; lines: number;
  };
  top: string;
  rows: string[];
  attrs: string[];
  hints: string;
  copied: { n: number; first: string; last: string }[];
}

// A step is a key name, or one of these tokens.
//   J, N        Shift+J, Shift+N
//   sp          the space bar
//   /text       open search, type text, Enter
//   s-esc       open search, then Escape
//   tick        run follow mode's timer callback once
//   append      append two lines to the file (so follow has something to find)
const SCENARIOS: Record<string, string[]> = {
  initial: [],
  // scrolling
  'down x2': ['down', 'down'],
  'down x3 up': ['down', 'down', 'down', 'up'],
  'j j k': ['j', 'j', 'k'],
  'up at top': ['up'],
  'pagedown': ['pagedown'],
  'pagedown x2 pageup': ['pagedown', 'pagedown', 'pageup'],
  'pagedown x3 (clamps)': ['pagedown', 'pagedown', 'pagedown'],
  'end': ['end'],
  'end home': ['end', 'home'],
  'end down (clamps)': ['end', 'down'],
  'space, no search': ['sp'],
  'space x2, no search': ['sp', 'sp'],
  // modes
  'hex': ['h'],
  'hex pagedown': ['h', 'pagedown'],
  'hex end': ['h', 'end'],
  'hex toggled back': ['h', 'h'],
  'd is hex': ['d'],
  'd d': ['d', 'd'],
  'ascii': ['a'],
  'ascii toggled back': ['a', 'a'],
  'junk (Shift+J)': ['J'],
  'junk toggled back': ['J', 'J'],
  'hex then ascii': ['h', 'a'],
  'junk then hex': ['J', 'h'],
  'ascii then junk': ['a', 'J'],
  'mode switch resets scroll': ['pagedown', 'h'],
  'mode back resets scroll': ['h', 'pagedown', 'h'],
  // wrap
  'wrap': ['w'],
  'wrap pagedown': ['w', 'pagedown'],
  'wrap end': ['w', 'end'],
  'wrap down x13': ['w', ...Array(13).fill('down')],
  'wrap off again': ['w', 'w'],
  'wrap resets scroll': ['pagedown', 'w'],
  // tab size
  'tab 8': ['t'],
  'tab back to 4': ['t', 't'],
  'tab 8 keeps scroll': ['pagedown', 't'],
  'wrap and tab 8': ['w', 't'],
  'hex tab 8': ['h', 't'],
  // search
  'search the': ['/the'],
  'search the, n': ['/the', 'n'],
  'search the, n n': ['/the', 'n', 'n'],
  'search the, N': ['/the', 'N'],
  'search the, N N': ['/the', 'N', 'N'],
  'search the, n x10 wraps': ['/the', ...Array(10).fill('n')],
  'search the, n x3, N x3': ['/the', 'n', 'n', 'n', 'N', 'N', 'N'],
  'search the, space': ['/the', 'sp'],
  'search the, space x2': ['/the', 'sp', 'sp'],
  'search upper case': ['/THE'],
  'search foo': ['/foo'],
  'search no match': ['/zzzzz'],
  'search no match then n': ['/zzzzz', 'n'],
  'search then pagedown': ['/the', 'pagedown'],
  'search then end': ['/the', 'end'],
  'search then home': ['/the', 'n', 'home'],
  'search then tab 8': ['/the', 't'],
  'search then wrap': ['/the', 'w'],
  'search then hex clears': ['/the', 'h'],
  'search then ascii clears': ['/the', 'a'],
  'search wide line, wrap on': ['w', '/wide'],
  'search a tab line': ['/col1'],
  'search tab line, tab 8': ['/col1', 't'],
  'search in hex': ['h', '/line'],
  'search in hex, n': ['h', '/line', 'n'],
  'search twice': ['/the', '/foo'],
  'search then empty search': ['/the', 's-enter'],
  'search cancelled': ['s-esc'],
  'n with no search': ['n'],
  'N with no search': ['N'],
  // gather
  'gather start': ['g'],
  'gather start then scroll': ['g', 'pagedown'],
  'gather copy': ['g', 'g'],
  'gather copy after pagedown': ['pagedown', 'g', 'g'],
  'gather start, pagedown, copy': ['g', 'pagedown', 'g'],
  'gather end then home (reversed)': ['end', 'g', 'home', 'g'],
  'gather copy clamps at end': ['end', 'g', 'g'],
  'gather cancel with Esc': ['g', 'escape'],
  'gather cancel then Esc exits': ['g', 'escape', 'escape'],
  'gather with wrap': ['w', 'g', 'g'],
  'gather in hex': ['h', 'g', 'g'],
  'gather after search': ['/the', 'g', 'g'],
  'gather twice': ['g', 'g', 'g'],
  // follow
  'follow on': ['f'],
  'follow tick': ['f', 'append', 'tick'],
  'follow tick then up': ['f', 'append', 'tick', 'up'],
  'follow toggled off': ['f', 'f'],
  'follow then up': ['f', 'up'],
  'follow then k': ['f', 'k'],
  'follow then down': ['f', 'down'],
  'follow then pagedown': ['f', 'pagedown'],
  'follow then pageup': ['f', 'pagedown', 'pageup'],
  'follow then home': ['f', 'end', 'home'],
  'follow then end': ['f', 'end'],
  'follow then hex': ['f', 'h'],
  'follow then q': ['f', 'q'],
  // leaving
  'q': ['q'],
  'Esc': ['escape'],
  'q after scrolling': ['pagedown', 'q'],
  'keys after q do nothing': ['q', 'down', 'h'],
};

// Run one step against the rig. `copies` collects what gather copied.
async function step(rig: Rig, s: string): Promise<void> {
  if (s === 'J') return rig.key('j', { shift: true });
  if (s === 'N') return rig.key('n', { shift: true });
  if (s === 'sp') return rig.key('space');
  if (s === 's-esc') {
    press(rig.screen, 's');
    await flush(20);
    press(rig.screen, 'escape');
    await flush(20);
    return;
  }
  if (s === 's-enter') {
    press(rig.screen, 's');
    await flush(20);
    press(rig.screen, 'enter');
    await flush(20);
    return;
  }
  if (s.startsWith('/')) {
    press(rig.screen, 's');
    await flush(20);
    for (const c of s.slice(1)) press(rig.screen, c);
    press(rig.screen, 'enter');
    await flush(25);
    return;
  }
  if (s === 'append') {
    fs.appendFileSync(rig.filePath, 'appended A\nappended B\n');
    return;
  }
  if (s === 'tick') {
    const cb = captured.cb;
    if (!cb) throw new Error('tick without follow mode on');
    await cb();
    await flush(8);
    return;
  }
  if (s === 'f') {
    const real = globalThis.setInterval;
    (globalThis as any).setInterval = (fn: () => Promise<void>) => {
      captured.cb = fn;
      return 4242 as any;
    };
    try {
      press(rig.screen, 'f');
    } finally {
      (globalThis as any).setInterval = real;
    }
    await flush(8);
    return;
  }
  return rig.key(s);
}

const captured: { cb: (() => Promise<void>) | null } = { cb: null };
const copies: string[] = [];

function snap(rig: Rig): Snap {
  const vs = rig.state.viewerState;
  // The bar ends with the file path (a temp dir that varies per run, and is
  // cut at the screen edge), so the path is dropped from the record.
  const norm = (s: string) => s.replace(/  \/.*$/, "  <path>");
  return {
    visible: rig.pane.isVisible(),
    exits: rig.exits.count,
    vs: vs && {
      scrollPos: vs.scrollPos, mode: vs.viewerMode, query: vs.searchQuery,
      matches: vs.searchMatches, current: vs.currentMatch, wrap: vs.wordWrap, tab: vs.tabSize,
      follow: vs.followMode, gStart: vs.gatherStart, gEnd: vs.gatherEnd,
      total: vs.totalLines, lines: vs.lines.length,
    },
    top: norm(topBarText(rig.screen)),
    rows: contentRows(rig.screen, 3),
    attrs: [0, 1, 2].map((i) => rowAttrs(rig.screen, i)),
    hints: rowText(rig.screen, 39).trimEnd(),
    copied: copies.map((c) => {
      const l = c.split('\n');
      return { n: l.length, first: l[0], last: l[l.length - 1] };
    }),
  };
}

let dir: string;
let savedTools: ReturnType<typeof getCachedTools>;
let spawnSpy: ReturnType<typeof spyOn>;
const observed: Record<string, Snap> = {};

beforeAll(() => {
  savedTools = getCachedTools();
  // No bat: lines are the file's own text, with no ANSI colour in them.
  setCachedToolsForTesting({
    fd: false, bat: false, trash: false, rsync: false, dust: false, duf: false, chafa: false,
  });
});

afterAll(() => {
  setCachedToolsForTesting(savedTools);
  if (process.env.PARITY_DUMP) {
    fs.writeFileSync(process.env.PARITY_DUMP, JSON.stringify(observed, null, 0).replace(/\},"/g, '},\n"'));
  }
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtreejs-parity-'));
  copies.length = 0;
  captured.cb = null;
  spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
    if (cmd[0] !== 'pbcopy') throw new Error('unexpected spawn: ' + cmd.join(' '));
    return {
      stdin: { write: (t: string) => { copies.push(t); }, end: () => {} },
      exited: Promise.resolve(0),
    };
  }) as any);
});

afterEach(() => {
  spawnSpy.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('viewer parity (C1)', () => {
  for (const [name, steps] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      const file = writeParityFixture(dir);
      const rig = await openFile(file);
      try {
        for (const s of steps) await step(rig, s);
        const got = snap(rig);
        observed[name] = got;
        if (process.env.PARITY_DUMP) return;
        expect(EXPECTED[name]).toBeDefined();
        expect(got).toEqual(EXPECTED[name]);
      } finally {
        rig.destroy();
      }
    });
  }

  test('every EXPECTED row has a scenario', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(SCENARIOS).sort());
  });
});

const EXPECTED: Record<string, Snap> = {
  "initial": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "down x2": {"visible": true, "exits": 0, "vs": {"scrollPos": 2, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 3/91  3K  <path>", "rows": [" 3 line 3: plain text number 3", " 4 line 4: plain text number 4", " 5 line 5: col1    col2    alpha beta"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x35"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "down x3 up": {"visible": true, "exits": 0, "vs": {"scrollPos": 2, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 3/91  3K  <path>", "rows": [" 3 line 3: plain text number 3", " 4 line 4: plain text number 4", " 5 line 5: col1    col2    alpha beta"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x35"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "j j k": {"visible": true, "exits": 0, "vs": {"scrollPos": 1, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 2/91  3K  <path>", "rows": [" 2 line 2: plain text number 2", " 3 line 3: plain text number 3", " 4 line 4: plain text number 4"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "up at top": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "pagedown": {"visible": true, "exits": 0, "vs": {"scrollPos": 36, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 37/91  3K  <path>", "rows": ["37 line 37: plain text number 37", "38 line 38: plain text number 38", "39 line 39: plain text number 39"], "attrs": ["1556x2,91668x30", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "pagedown x2 pageup": {"visible": true, "exits": 0, "vs": {"scrollPos": 19, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 20/91  3K  <path>", "rows": ["20 line 20:    col1    col2    alpha beta", "21 line 21: the quick brown fox, the lazy dog", "22 line 22: foo bar foo bar foo"], "attrs": ["1556x2,91668x39", "1556x2,91668x43", "1556x2,91668x29"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "pagedown x3 (clamps)": {"visible": true, "exits": 0, "vs": {"scrollPos": 55, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 56/91  3K  <path>", "rows": ["56 line 56: the quick brown fox, the lazy dog", "57 line 57: plain text number 57", "58 line 58: plain text number 58"], "attrs": ["1556x2,91668x43", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "end": {"visible": true, "exits": 0, "vs": {"scrollPos": 55, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 56/91  3K  <path>", "rows": ["56 line 56: the quick brown fox, the lazy dog", "57 line 57: plain text number 57", "58 line 58: plain text number 58"], "attrs": ["1556x2,91668x43", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "end home": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "end down (clamps)": {"visible": true, "exits": 0, "vs": {"scrollPos": 55, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 56/91  3K  <path>", "rows": ["56 line 56: the quick brown fox, the lazy dog", "57 line 57: plain text number 57", "58 line 58: plain text number 58"], "attrs": ["1556x2,91668x43", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "space, no search": {"visible": true, "exits": 0, "vs": {"scrollPos": 36, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 37/91  3K  <path>", "rows": ["37 line 37: plain text number 37", "38 line 38: plain text number 38", "39 line 39: plain text number 39"], "attrs": ["1556x2,91668x30", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "space x2, no search": {"visible": true, "exits": 0, "vs": {"scrollPos": 55, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 56/91  3K  <path>", "rows": ["56 line 56: the quick brown fox, the lazy dog", "57 line 57: plain text number 57", "58 line 58: plain text number 58"], "attrs": ["1556x2,91668x43", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "hex": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "hex", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 194, "lines": 194}, "top": " Hex: fixture.txt  Line 1/194  15K  <path>", "rows": ["  1 00000000  6C 69 6E 65 20 31 3A 20 70 6C 61 69 6E 20 74 65  |line 1: plain te|", "  2 00000010  78 74 20 6E 75 6D 62 65 72 20 31 0A 6C 69 6E 65  |xt number 1.line|", "  3 00000020  20 32 3A 20 70 6C 61 69 6E 20 74 65 78 74 20 6E  | 2: plain text n|"], "attrs": ["1556x3,91668x78", "1556x3,91668x78", "1556x3,91668x78"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "hex pagedown": {"visible": true, "exits": 0, "vs": {"scrollPos": 36, "mode": "hex", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 194, "lines": 194}, "top": " Hex: fixture.txt  Line 37/194  15K  <path>", "rows": [" 37 00000240  69 64 65 20 77 69 64 65 20 77 69 64 65 20 77 69  |ide wide wide wi|", " 38 00000250  64 65 20 77 69 64 65 20 77 69 64 65 20 77 69 64  |de wide wide wid|", " 39 00000260  65 20 77 69 64 65 20 77 69 64 65 20 77 69 64 65  |e wide wide wide|"], "attrs": ["1556x3,91668x78", "1556x3,91668x78", "1556x3,91668x78"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "hex end": {"visible": true, "exits": 0, "vs": {"scrollPos": 158, "mode": "hex", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 194, "lines": 194}, "top": " Hex: fixture.txt  Line 159/194  15K  <path>", "rows": ["159 000009E0  6E 65 20 37 33 3A 20 70 6C 61 69 6E 20 74 65 78  |ne 73: plain tex|", "160 000009F0  74 20 6E 75 6D 62 65 72 20 37 33 0A 6C 69 6E 65  |t number 73.line|", "161 00000A00  20 37 34 3A 20 70 6C 61 69 6E 20 74 65 78 74 20  | 74: plain text |"], "attrs": ["1556x3,91668x78", "1556x3,91668x78", "1556x3,91668x78"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "hex toggled back": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "d is hex": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "hex", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 194, "lines": 194}, "top": " Hex: fixture.txt  Line 1/194  15K  <path>", "rows": ["  1 00000000  6C 69 6E 65 20 31 3A 20 70 6C 61 69 6E 20 74 65  |line 1: plain te|", "  2 00000010  78 74 20 6E 75 6D 62 65 72 20 31 0A 6C 69 6E 65  |xt number 1.line|", "  3 00000020  20 32 3A 20 70 6C 61 69 6E 20 74 65 78 74 20 6E  | 2: plain text n|"], "attrs": ["1556x3,91668x78", "1556x3,91668x78", "1556x3,91668x78"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "d d": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "ascii": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "ascii", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " ASCII: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "ascii toggled back": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "junk (Shift+J)": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "junk", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Junk: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "junk toggled back": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "hex then ascii": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "ascii", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " ASCII: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "junk then hex": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "hex", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 194, "lines": 194}, "top": " Hex: fixture.txt  Line 1/194  15K  <path>", "rows": ["  1 00000000  6C 69 6E 65 20 31 3A 20 70 6C 61 69 6E 20 74 65  |line 1: plain te|", "  2 00000010  78 74 20 6E 75 6D 62 65 72 20 31 0A 6C 69 6E 65  |xt number 1.line|", "  3 00000020  20 32 3A 20 70 6C 61 69 6E 20 74 65 78 74 20 6E  | 2: plain text n|"], "attrs": ["1556x3,91668x78", "1556x3,91668x78", "1556x3,91668x78"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "ascii then junk": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "junk", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Junk: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "mode switch resets scroll": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "hex", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 194, "lines": 194}, "top": " Hex: fixture.txt  Line 1/194  15K  <path>", "rows": ["  1 00000000  6C 69 6E 65 20 31 3A 20 70 6C 61 69 6E 20 74 65  |line 1: plain te|", "  2 00000010  78 74 20 6E 75 6D 62 65 72 20 31 0A 6C 69 6E 65  |xt number 1.line|", "  3 00000020  20 32 3A 20 70 6C 61 69 6E 20 74 65 78 74 20 6E  | 2: plain text n|"], "attrs": ["1556x3,91668x78", "1556x3,91668x78", "1556x3,91668x78"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "mode back resets scroll": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "wrap": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": true, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text Wrap: fixture.txt  Line 1/93  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "wrap pagedown": {"visible": true, "exits": 0, "vs": {"scrollPos": 36, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": true, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text Wrap: fixture.txt  Line 37/93  3K  <path>", "rows": ["37 line 35:    col1    col2    alpha beta", "38 line 36: plain text number 36", "39 line 37: plain text number 37"], "attrs": ["1556x2,91668x39", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "wrap end": {"visible": true, "exits": 0, "vs": {"scrollPos": 55, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": true, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text Wrap: fixture.txt  Line 56/93  3K  <path>", "rows": ["56 line 54: plain text number 54", "57 line 55:    col1    col2    alpha beta", "58 line 56: the quick brown fox, the lazy dog"], "attrs": ["1556x2,91668x30", "1556x2,91668x39", "1556x2,91668x43"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "wrap down x13": {"visible": true, "exits": 0, "vs": {"scrollPos": 13, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": true, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text Wrap: fixture.txt  Line 14/93  3K  <path>", "rows": ["14 ide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide END", "15 line 13: plain text number 13", "16 line 14: the quick brown fox, the lazy dog"], "attrs": ["1556x2,91668x93", "1556x2,91668x30", "1556x2,91668x43"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "wrap off again": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "wrap resets scroll": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": true, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text Wrap: fixture.txt  Line 1/93  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "tab 8": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 8, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(8)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "tab back to 4": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "tab 8 keeps scroll": {"visible": true, "exits": 0, "vs": {"scrollPos": 36, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 8, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 37/91  3K  <path>", "rows": ["37 line 37: plain text number 37", "38 line 38: plain text number 38", "39 line 39: plain text number 39"], "attrs": ["1556x2,91668x30", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(8)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "wrap and tab 8": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": true, "tab": 8, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text Wrap: fixture.txt  Line 1/93  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(8)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "hex tab 8": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "hex", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 8, "follow": false, "gStart": null, "gEnd": null, "total": 194, "lines": 194}, "top": " Hex: fixture.txt  Line 1/194  15K  <path>", "rows": ["  1 00000000  6C 69 6E 65 20 31 3A 20 70 6C 61 69 6E 20 74 65  |line 1: plain te|", "  2 00000010  78 74 20 6E 75 6D 62 65 72 20 31 0A 6C 69 6E 65  |xt number 1.line|", "  3 00000020  20 32 3A 20 70 6C 61 69 6E 20 74 65 78 74 20 6E  | 2: plain text n|"], "attrs": ["1556x3,91668x78", "1556x3,91668x78", "1556x3,91668x78"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(8)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "search the": {"visible": true, "exits": 0, "vs": {"scrollPos": 6, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 0, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 7/91  3K  [1/10]  <path>", "rows": [" 7 line 7: the quick brown fox, the lazy dog", " 8 line 8: plain text number 8", " 9 line 9: plain text number 9"], "attrs": ["1556x2,91668x9,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search the, n": {"visible": true, "exits": 0, "vs": {"scrollPos": 13, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 14/91  3K  [2/10]  <path>", "rows": ["14 line 14: the quick brown fox, the lazy dog", "15 line 15:    col1    col2    alpha beta", "16 line 16: plain text number 16"], "attrs": ["1556x2,91668x10,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x39", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search the, n n": {"visible": true, "exits": 0, "vs": {"scrollPos": 20, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 2, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 21/91  3K  [3/10]  <path>", "rows": ["21 line 21: the quick brown fox, the lazy dog", "22 line 22: foo bar foo bar foo", "23 line 23: plain text number 23"], "attrs": ["1556x2,91668x10,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x29", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search the, N": {"visible": true, "exits": 0, "vs": {"scrollPos": 83, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 9, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 84/91  3K  [10/10]  <path>", "rows": ["84 line 84: the quick brown fox, the lazy dog", "85 line 85:    col1    col2    alpha beta", "86 line 86: plain text number 86"], "attrs": ["1556x2,91668x10,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x39", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search the, N N": {"visible": true, "exits": 0, "vs": {"scrollPos": 76, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 8, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 77/91  3K  [9/10]  <path>", "rows": ["77 line 77: the quick brown fox, the lazy dog", "78 line 78: plain text number 78", "79 line 79: plain text number 79"], "attrs": ["1556x2,91668x10,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search the, n x10 wraps": {"visible": true, "exits": 0, "vs": {"scrollPos": 6, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 0, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 7/91  3K  [1/10]  <path>", "rows": [" 7 line 7: the quick brown fox, the lazy dog", " 8 line 8: plain text number 8", " 9 line 9: plain text number 9"], "attrs": ["1556x2,91668x9,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search the, n x3, N x3": {"visible": true, "exits": 0, "vs": {"scrollPos": 6, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 0, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 7/91  3K  [1/10]  <path>", "rows": [" 7 line 7: the quick brown fox, the lazy dog", " 8 line 8: plain text number 8", " 9 line 9: plain text number 9"], "attrs": ["1556x2,91668x9,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search the, space": {"visible": true, "exits": 0, "vs": {"scrollPos": 13, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 14/91  3K  [2/10]  <path>", "rows": ["14 line 14: the quick brown fox, the lazy dog", "15 line 15:    col1    col2    alpha beta", "16 line 16: plain text number 16"], "attrs": ["1556x2,91668x10,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x39", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search the, space x2": {"visible": true, "exits": 0, "vs": {"scrollPos": 20, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 2, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 21/91  3K  [3/10]  <path>", "rows": ["21 line 21: the quick brown fox, the lazy dog", "22 line 22: foo bar foo bar foo", "23 line 23: plain text number 23"], "attrs": ["1556x2,91668x10,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x29", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search upper case": {"visible": true, "exits": 0, "vs": {"scrollPos": 6, "mode": "text", "query": "THE", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 0, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 7/91  3K  [1/10]  <path>", "rows": [" 7 line 7: the quick brown fox, the lazy dog", " 8 line 8: plain text number 8", " 9 line 9: plain text number 9"], "attrs": ["1556x2,91668x9,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search foo": {"visible": true, "exits": 0, "vs": {"scrollPos": 10, "mode": "text", "query": "foo", "matches": [10, 21, 32, 43, 65, 87], "current": 0, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 11/91  3K  [1/6]  <path>", "rows": ["11 line 11: foo bar foo bar foo", "12 line 12: wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide", "wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide"], "attrs": ["1556x2,91668x10,2051x3,91668x5,2051x3,91668x5,2051x3", "1556x2,91668x114", "91668x114"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search no match": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "zzzzz", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "search no match then n": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "zzzzz", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "search then pagedown": {"visible": true, "exits": 0, "vs": {"scrollPos": 42, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 0, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 43/91  3K  [1/10]  <path>", "rows": ["43 line 43: plain text number 43", "44 line 44: foo bar foo bar foo", "45 line 45:    col1    col2    alpha beta"], "attrs": ["1556x2,91668x30", "1556x2,91668x29", "1556x2,91668x39"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search then end": {"visible": true, "exits": 0, "vs": {"scrollPos": 55, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 0, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 56/91  3K  [1/10]  <path>", "rows": ["56 line 56: the quick brown fox, the lazy dog", "57 line 57: plain text number 57", "58 line 58: plain text number 58"], "attrs": ["1556x2,91668x10,2049x3,91668x18,2049x3,91668x9", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search then home": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  [2/10]  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search then tab 8": {"visible": true, "exits": 0, "vs": {"scrollPos": 6, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 0, "wrap": false, "tab": 8, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 7/91  3K  [1/10]  <path>", "rows": [" 7 line 7: the quick brown fox, the lazy dog", " 8 line 8: plain text number 8", " 9 line 9: plain text number 9"], "attrs": ["1556x2,91668x9,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(8)  f Follow  g Gather  a", "copied": []},
  "search then wrap": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 0, "wrap": true, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text Wrap: fixture.txt  Line 1/93  3K  [1/10]  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search then hex clears": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "hex", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 194, "lines": 194}, "top": " Hex: fixture.txt  Line 1/194  15K  <path>", "rows": ["  1 00000000  6C 69 6E 65 20 31 3A 20 70 6C 61 69 6E 20 74 65  |line 1: plain te|", "  2 00000010  78 74 20 6E 75 6D 62 65 72 20 31 0A 6C 69 6E 65  |xt number 1.line|", "  3 00000020  20 32 3A 20 70 6C 61 69 6E 20 74 65 78 74 20 6E  | 2: plain text n|"], "attrs": ["1556x3,91668x78", "1556x3,91668x78", "1556x3,91668x78"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "search then ascii clears": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "ascii", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " ASCII: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "search wide line, wrap on": {"visible": true, "exits": 0, "vs": {"scrollPos": 11, "mode": "text", "query": "wide", "matches": [11], "current": 0, "wrap": true, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text Wrap: fixture.txt  Line 12/93  3K  [1/1]  <path>", "rows": ["12 line 12: wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide w", "13 ide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide w", "14 ide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide END"], "attrs": ["1556x2,91668x10,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x1,2051x4,91668x2", "1556x2,91668x111", "1556x2,91668x93"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search a tab line": {"visible": true, "exits": 0, "vs": {"scrollPos": 4, "mode": "text", "query": "col1", "matches": [4, 9, 14, 19, 24, 29, 34, 39, 44, 49, 54, 59, 64, 69, 74, 79, 84, 89], "current": 0, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 5/91  3K  [1/18]  <path>", "rows": [" 5 line 5: col1    col2    alpha beta", " 6 line 6: plain text number 6", " 7 line 7: the quick brown fox, the lazy dog"], "attrs": ["1556x2,91668x9,2051x4,91668x22", "1556x2,91668x28", "1556x2,91668x42"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search tab line, tab 8": {"visible": true, "exits": 0, "vs": {"scrollPos": 4, "mode": "text", "query": "col1", "matches": [4, 9, 14, 19, 24, 29, 34, 39, 44, 49, 54, 59, 64, 69, 74, 79, 84, 89], "current": 0, "wrap": false, "tab": 8, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 5/91  3K  [1/18]  <path>", "rows": [" 5 line 5: col1    col2    alpha beta", " 6 line 6: plain text number 6", " 7 line 7: the quick brown fox, the lazy dog"], "attrs": ["1556x2,91668x9,2051x4,91668x22", "1556x2,91668x28", "1556x2,91668x42"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(8)  f Follow  g Gather  a", "copied": []},
  "search in hex": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "hex", "query": "line", "matches": [0, 1, 3, 5, 7, 10, 13, 16, 18, 20, 44, 46, 48, 50, 52, 55, 58, 60, 62, 64, 67, 69, 72, 74, 76, 81, 83, 85, 87, 89, 91, 94, 96, 99, 101, 103, 106, 108, 110, 113, 115, 120, 122, 124, 127, 129, 132, 134, 136, 138, 141, 146, 148, 150, 152, 154, 156, 159, 161, 163, 165, 168, 173, 175, 177, 179, 182, 185, 187, 189, 191], "current": 0, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 194, "lines": 194}, "top": " Hex: fixture.txt  Line 1/194  15K  [1/71]  <path>", "rows": ["  1 00000000  6C 69 6E 65 20 31 3A 20 70 6C 61 69 6E 20 74 65  |line 1: plain te|", "  2 00000010  78 74 20 6E 75 6D 62 65 72 20 31 0A 6C 69 6E 65  |xt number 1.line|", "  3 00000020  20 32 3A 20 70 6C 61 69 6E 20 74 65 78 74 20 6E  | 2: plain text n|"], "attrs": ["1556x3,91668x61,2051x4,91668x13", "1556x3,91668x73,2049x4,91668x1", "1556x3,91668x78"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search in hex, n": {"visible": true, "exits": 0, "vs": {"scrollPos": 1, "mode": "hex", "query": "line", "matches": [0, 1, 3, 5, 7, 10, 13, 16, 18, 20, 44, 46, 48, 50, 52, 55, 58, 60, 62, 64, 67, 69, 72, 74, 76, 81, 83, 85, 87, 89, 91, 94, 96, 99, 101, 103, 106, 108, 110, 113, 115, 120, 122, 124, 127, 129, 132, 134, 136, 138, 141, 146, 148, 150, 152, 154, 156, 159, 161, 163, 165, 168, 173, 175, 177, 179, 182, 185, 187, 189, 191], "current": 1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 194, "lines": 194}, "top": " Hex: fixture.txt  Line 2/194  15K  [2/71]  <path>", "rows": ["  2 00000010  78 74 20 6E 75 6D 62 65 72 20 31 0A 6C 69 6E 65  |xt number 1.line|", "  3 00000020  20 32 3A 20 70 6C 61 69 6E 20 74 65 78 74 20 6E  | 2: plain text n|", "  4 00000030  75 6D 62 65 72 20 32 0A 6C 69 6E 65 20 33 3A 20  |umber 2.line 3: |"], "attrs": ["1556x3,91668x73,2051x4,91668x1", "1556x3,91668x78", "1556x3,91668x69,2049x4,91668x5"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search twice": {"visible": true, "exits": 0, "vs": {"scrollPos": 10, "mode": "text", "query": "foo", "matches": [10, 21, 32, 43, 65, 87], "current": 0, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 11/91  3K  [1/6]  <path>", "rows": ["11 line 11: foo bar foo bar foo", "12 line 12: wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide", "wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide wide"], "attrs": ["1556x2,91668x10,2051x3,91668x5,2051x3,91668x5,2051x3", "1556x2,91668x114", "91668x114"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search then empty search": {"visible": true, "exits": 0, "vs": {"scrollPos": 6, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 0, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 7/91  3K  [1/10]  <path>", "rows": [" 7 line 7: the quick brown fox, the lazy dog", " 8 line 8: plain text number 8", " 9 line 9: plain text number 9"], "attrs": ["1556x2,91668x9,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": []},
  "search cancelled": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "n with no search": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "N with no search": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "gather start": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": 0, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  GATHER from line 1  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "gather start then scroll": {"visible": true, "exits": 0, "vs": {"scrollPos": 36, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": 0, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 37/91  3K  GATHER from line 1  <path>", "rows": ["37 line 37: plain text number 37", "38 line 38: plain text number 38", "39 line 39: plain text number 39"], "attrs": ["1556x2,91668x30", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "gather copy": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": [{"n": 36, "first": "line 1: plain text number 1", "last": "line 36: plain text number 36"}]},
  "gather copy after pagedown": {"visible": true, "exits": 0, "vs": {"scrollPos": 36, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 37/91  3K  <path>", "rows": ["37 line 37: plain text number 37", "38 line 38: plain text number 38", "39 line 39: plain text number 39"], "attrs": ["1556x2,91668x30", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": [{"n": 36, "first": "line 37: plain text number 37", "last": "line 72: plain text number 72"}]},
  "gather start, pagedown, copy": {"visible": true, "exits": 0, "vs": {"scrollPos": 36, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 37/91  3K  <path>", "rows": ["37 line 37: plain text number 37", "38 line 38: plain text number 38", "39 line 39: plain text number 39"], "attrs": ["1556x2,91668x30", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": [{"n": 72, "first": "line 1: plain text number 1", "last": "line 72: plain text number 72"}]},
  "gather end then home (reversed)": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": [{"n": 21, "first": "line 36: plain text number 36", "last": "line 56: the quick brown fox, the lazy dog"}]},
  "gather copy clamps at end": {"visible": true, "exits": 0, "vs": {"scrollPos": 55, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 56/91  3K  <path>", "rows": ["56 line 56: the quick brown fox, the lazy dog", "57 line 57: plain text number 57", "58 line 58: plain text number 58"], "attrs": ["1556x2,91668x43", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": [{"n": 36, "first": "line 56: the quick brown fox, the lazy dog", "last": ""}]},
  "gather cancel with Esc": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "gather cancel then Esc exits": {"visible": false, "exits": 1, "vs": null, "top": "", "rows": ["", "", ""], "attrs": ["", "", ""], "hints": "", "copied": []},
  "gather with wrap": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": true, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text Wrap: fixture.txt  Line 1/93  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": [{"n": 36, "first": "line 1: plain text number 1", "last": "line 36: plain text number 36"}]},
  "gather in hex": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "hex", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 194, "lines": 194}, "top": " Hex: fixture.txt  Line 1/194  15K  <path>", "rows": ["  1 00000000  6C 69 6E 65 20 31 3A 20 70 6C 61 69 6E 20 74 65  |line 1: plain te|", "  2 00000010  78 74 20 6E 75 6D 62 65 72 20 31 0A 6C 69 6E 65  |xt number 1.line|", "  3 00000020  20 32 3A 20 70 6C 61 69 6E 20 74 65 78 74 20 6E  | 2: plain text n|"], "attrs": ["1556x3,91668x78", "1556x3,91668x78", "1556x3,91668x78"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": [{"n": 36, "first": "00000000  6C 69 6E 65 20 31 3A 20 70 6C 61 69 6E 20 74 65  |line 1: plain te|", "last": "00000230  77 69 64 65 20 77 69 64 65 20 77 69 64 65 20 77  |wide wide wide w|"}]},
  "gather after search": {"visible": true, "exits": 0, "vs": {"scrollPos": 6, "mode": "text", "query": "the", "matches": [6, 13, 20, 27, 41, 48, 55, 62, 76, 83], "current": 0, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 7/91  3K  [1/10]  <path>", "rows": [" 7 line 7: the quick brown fox, the lazy dog", " 8 line 8: plain text number 8", " 9 line 9: plain text number 9"], "attrs": ["1556x2,91668x9,2051x3,91668x18,2051x3,91668x9", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  n Next  N Prev  w Wrap  t Tab(4)  f Follow  g Gather  a", "copied": [{"n": 36, "first": "line 7: the quick brown fox, the lazy dog", "last": "line 42: the quick brown fox, the lazy dog"}]},
  "gather twice": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": 0, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  GATHER from line 1  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": [{"n": 36, "first": "line 1: plain text number 1", "last": "line 36: plain text number 36"}]},
  "follow on": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": true, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text FOLLOW: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "follow tick": {"visible": true, "exits": 0, "vs": {"scrollPos": 57, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": true, "gStart": null, "gEnd": null, "total": 93, "lines": 93}, "top": " Text FOLLOW: fixture.txt  Line 58/93  3K  <path>", "rows": ["58 line 58: plain text number 58", "59 line 59: plain text number 59", "60 line 60:    col1    col2    alpha beta"], "attrs": ["1556x2,91668x30", "1556x2,91668x30", "1556x2,91668x39"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "follow tick then up": {"visible": true, "exits": 0, "vs": {"scrollPos": 56, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 93, "lines": 93}, "top": " Text: fixture.txt  Line 57/93  3K  <path>", "rows": ["57 line 57: plain text number 57", "58 line 58: plain text number 58", "59 line 59: plain text number 59"], "attrs": ["1556x2,91668x30", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "follow toggled off": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "follow then up": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "follow then k": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "follow then down": {"visible": true, "exits": 0, "vs": {"scrollPos": 1, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": true, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text FOLLOW: fixture.txt  Line 2/91  3K  <path>", "rows": [" 2 line 2: plain text number 2", " 3 line 3: plain text number 3", " 4 line 4: plain text number 4"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "follow then pagedown": {"visible": true, "exits": 0, "vs": {"scrollPos": 36, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": true, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text FOLLOW: fixture.txt  Line 37/91  3K  <path>", "rows": ["37 line 37: plain text number 37", "38 line 38: plain text number 38", "39 line 39: plain text number 39"], "attrs": ["1556x2,91668x30", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "follow then pageup": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "follow then home": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": false, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text: fixture.txt  Line 1/91  3K  <path>", "rows": [" 1 line 1: plain text number 1", " 2 line 2: plain text number 2", " 3 line 3: plain text number 3"], "attrs": ["1556x2,91668x28", "1556x2,91668x28", "1556x2,91668x28"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "follow then end": {"visible": true, "exits": 0, "vs": {"scrollPos": 55, "mode": "text", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": true, "gStart": null, "gEnd": null, "total": 91, "lines": 91}, "top": " Text FOLLOW: fixture.txt  Line 56/91  3K  <path>", "rows": ["56 line 56: the quick brown fox, the lazy dog", "57 line 57: plain text number 57", "58 line 58: plain text number 58"], "attrs": ["1556x2,91668x43", "1556x2,91668x30", "1556x2,91668x30"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "follow then hex": {"visible": true, "exits": 0, "vs": {"scrollPos": 0, "mode": "hex", "query": "", "matches": [], "current": -1, "wrap": false, "tab": 4, "follow": true, "gStart": null, "gEnd": null, "total": 194, "lines": 194}, "top": " Hex FOLLOW: fixture.txt  Line 1/194  15K  <path>", "rows": ["  1 00000000  6C 69 6E 65 20 31 3A 20 70 6C 61 69 6E 20 74 65  |line 1: plain te|", "  2 00000010  78 74 20 6E 75 6D 62 65 72 20 31 0A 6C 69 6E 65  |xt number 1.line|", "  3 00000020  20 32 3A 20 70 6C 61 69 6E 20 74 65 78 74 20 6E  | 2: plain text n|"], "attrs": ["1556x3,91668x78", "1556x3,91668x78", "1556x3,91668x78"], "hints": " ↑↓ Scroll  PgUp/PgDn Page  Home/End Jump  h Hex  s Search  w Wrap  t Tab(4)  f Follow  g Gather  a ASCII  j Junk", "copied": []},
  "follow then q": {"visible": false, "exits": 1, "vs": null, "top": "", "rows": ["", "", ""], "attrs": ["", "", ""], "hints": "", "copied": []},
  "q": {"visible": false, "exits": 1, "vs": null, "top": "", "rows": ["", "", ""], "attrs": ["", "", ""], "hints": "", "copied": []},
  "Esc": {"visible": false, "exits": 1, "vs": null, "top": "", "rows": ["", "", ""], "attrs": ["", "", ""], "hints": "", "copied": []},
  "q after scrolling": {"visible": false, "exits": 1, "vs": null, "top": "", "rows": ["", "", ""], "attrs": ["", "", ""], "hints": "", "copied": []},
  "keys after q do nothing": {"visible": false, "exits": 1, "vs": null, "top": "", "rows": ["", "", ""], "attrs": ["", "", ""], "hints": "", "copied": []},
};
