// The viewer's model: everything the viewer knows and decides, with no blessed
// in it. The shell (viewer-pane.ts) maps keys onto these methods and the
// renderer (viewer-renderer.ts) draws `window()`; neither holds a copy of the
// state.
//
// State. The model operates on the app's own `ViewerState` object (the one
// `AppState.viewerState` points at), so there is one copy of scroll, mode,
// search, wrap, tab size, follow and gather. `ViewerState.lines` becomes an
// accessor over the model's line source, so reading it still gives the lines
// of the current mode (in hex mode that builds the whole dump, which nothing in
// the app does).
//
// Cost. What is drawn is derived from the raw lines (tabs expanded, then wrapped
// when wrap is on). That derivation is cached under (source, mode, tab size,
// wrap, width) and is recomputed only when one of those changes, never on
// scroll, so a scroll costs the height of the window and not the length of the
// file. Hex lines are never derived in advance: the model holds the file's
// bytes and builds a 16-byte line only when `window()` asks for it.
//
// Quirks kept on purpose (the parity table pins them): scrolling is bounded by
// the raw line count, not the wrapped one; search and gather index the raw
// lines while the window indexes the displayed ones.

import type { ViewerMode, ViewerState } from '../state/app-state.js';
import {
  expandTabs, wrapLines, searchInLines, hexLine, hexLineCount, HEX_BYTES_PER_LINE,
} from '../fs/view.js';

/** A read-only run of lines, possibly built on demand. */
export interface LineSource {
  /** 'hex' sources build their lines on demand from bytes. */
  readonly kind: 'text' | 'hex';
  readonly length: number;
  at(index: number): string;
  /** Lines [start, end), clipped to the source. */
  slice(start: number, end: number): string[];
  /** Every line. For a hex source this builds them all and remembers them. */
  toArray(): string[];
  /** `toArray().join('\n').length`, without building the join when it can be known. */
  joinedLength(): number;
}

export function arraySource(lines: string[]): LineSource {
  let joined: number | null = null;
  return {
    kind: 'text',
    length: lines.length,
    at: (i) => lines[i],
    slice: (a, b) => lines.slice(a, b),
    toArray: () => lines,
    joinedLength() {
      if (joined === null) {
        let sum = 0;
        for (const l of lines) sum += l.length;
        joined = lines.length === 0 ? 0 : sum + lines.length - 1;
      }
      return joined;
    },
  };
}

// offset(8) + 2 spaces + 47 hex columns + 2 spaces + '|' + 16 text + '|'
const HEX_FULL_LINE_WIDTH = 8 + 2 + (HEX_BYTES_PER_LINE * 3 - 1) + 2 + 1 + HEX_BYTES_PER_LINE + 1;

export function hexSource(bytes: Uint8Array): LineSource {
  const length = hexLineCount(bytes.length);
  let all: string[] | null = null;
  return {
    kind: 'hex',
    length,
    at: (i) => hexLine(bytes, i),
    slice(start, end) {
      const out: string[] = [];
      for (let i = Math.max(0, start); i < Math.min(length, end); i++) out.push(hexLine(bytes, i));
      return out;
    },
    toArray() {
      if (!all) all = this.slice(0, length);
      return all;
    },
    joinedLength() {
      if (length === 0) return 0;
      const rest = bytes.length % HEX_BYTES_PER_LINE;
      const fullLines = rest === 0 ? length : length - 1;
      const tail = rest === 0 ? 0 : 8 + 2 + (HEX_BYTES_PER_LINE * 3 - 1) + 2 + 1 + rest + 1;
      return fullLines * HEX_FULL_LINE_WIDTH + tail + length - 1;
    },
  };
}

export type MatchKind = 'none' | 'match' | 'current';

export interface WindowRow {
  /** 0-based index among the displayed lines. */
  index: number;
  /** 1-based line number as drawn. */
  number: number;
  /** The displayed text: tabs expanded, wrapped. Raw, not escaped. */
  text: string;
  match: MatchKind;
  /** Inside a completed gather range. */
  gathered: boolean;
}

export interface ViewerWindow {
  rows: WindowRow[];
  scrollPos: number;
  /** How many lines there are to display (after tab expansion and wrap). */
  displayLength: number;
  /** Width of the line-number column. */
  totalDigits: number;
}

export interface ViewerModel {
  /** The app's `ViewerState` this model reads and writes. */
  readonly state: ViewerState;
  /** The path shown in the bars; not part of `ViewerState`. */
  filePath: string;

  // Content
  /** Replace the raw lines with text lines. Does not move the scroll position. */
  loadText(lines: string[]): void;
  /** Replace the raw lines with a hex dump of `bytes`, built per window. */
  loadHex(bytes: Uint8Array): void;
  /** The raw line count (what scrolling is bounded by). */
  rawLength(): number;
  /** Characters in the raw lines joined by newlines (for the size label). */
  sizeChars(): number;
  /** The usable text width for wrapping; takes effect only when wrap is on. */
  setWidth(width: number): void;

  // What to draw
  displayLength(): number;
  window(height: number): ViewerWindow;

  // Scroll
  scrollUp(amount: number): void;
  scrollDown(amount: number, height: number): void;
  scrollToTop(): void;
  scrollToBottom(height: number): void;

  // Mode, wrap, tabs
  /** Switch mode and drop the search; the lines for it are loaded separately. */
  setMode(mode: ViewerMode): void;
  toggleWrap(): void;
  toggleTabSize(): void;

  // Search
  search(query: string): void;
  nextMatch(): void;
  prevMatch(): void;

  // Gather
  /** First call marks the start and returns null; the second marks the end and returns the text. */
  gather(height: number): string | null;
  clearGather(): void;
  isGathering(): boolean;
}

const DEFAULT_WIDTH = 20;

/** A fresh state for a viewer opened without one (the app always supplies it). */
export function defaultViewerState(filePath: string, lines: string[]): ViewerState {
  return {
    filePath, lines, scrollPos: 0, totalLines: lines.length, viewerMode: 'text',
    searchQuery: '', searchMatches: [], currentMatch: -1, wordWrap: false, tabSize: 4,
    followMode: false, gatherStart: null, gatherEnd: null,
  };
}

export function createViewerModel(state: ViewerState, filePath = state.filePath): ViewerModel {
  // Read `lines` as plain data: a state this model (or an earlier one) already
  // wrapped has the accessor, and reading that could build a whole hex dump.
  const own = Object.getOwnPropertyDescriptor(state, 'lines');
  let source: LineSource = arraySource(own && 'value' in own ? own.value : []);
  let sourceVersion = 0;
  let width = DEFAULT_WIDTH;
  let cache: { key: string; lines: LineSource } | null = null;
  let matchSet: { of: number[]; set: Set<number> } | null = null;

  const loadSource = (next: LineSource): void => {
    source = next;
    sourceVersion++;
    cache = null;
    state.totalLines = next.length;
  };

  // `lines` on the shared state reads through to the current source.
  Object.defineProperty(state, 'lines', {
    configurable: true,
    enumerable: true,
    get: () => source.toArray(),
    set: (lines: string[]) => loadSource(arraySource(lines)),
  });

  // The displayed lines, recomputed only when the key changes. A hex dump has
  // no tabs and a full line is 77 columns, so it is shown as it is unless wrap
  // is on and narrower than that.
  function derived(): LineSource {
    const wrap = state.wordWrap;
    const wrapWidth = wrap ? Math.max(DEFAULT_WIDTH, width) : 0;
    const key = `${sourceVersion}|${state.viewerMode}|${state.tabSize}|${wrap}|${wrapWidth}`;
    if (cache && cache.key === key) return cache.lines;

    let lines: LineSource;
    if (source.kind === 'hex') {
      lines = wrap && wrapWidth < HEX_FULL_LINE_WIDTH
        ? arraySource(wrapLines(source.toArray(), wrapWidth))
        : source;
    } else {
      let out = source.toArray();
      if (state.tabSize) {
        const tab = state.tabSize;
        out = out.map((line) => expandTabs(line, tab));
      }
      if (wrap) out = wrapLines(out, wrapWidth);
      lines = arraySource(out);
    }
    cache = { key, lines };
    return lines;
  }

  function matchedLines(): Set<number> {
    if (!matchSet || matchSet.of !== state.searchMatches) {
      matchSet = { of: state.searchMatches, set: new Set(state.searchMatches) };
    }
    return matchSet.set;
  }

  function findMatches(query: string): number[] {
    if (source.kind === 'text') return searchInLines(source.toArray(), query);
    if (!query) return [];
    const lower = query.toLowerCase();
    const found: number[] = [];
    for (let i = 0; i < source.length; i++) {
      if (source.at(i).toLowerCase().includes(lower)) found.push(i);
    }
    return found;
  }

  function jumpToCurrentMatch(): void {
    state.scrollPos = state.searchMatches[state.currentMatch];
  }

  return {
    state,
    filePath,

    loadText(lines) {
      loadSource(arraySource(lines));
    },
    loadHex(bytes) {
      loadSource(hexSource(bytes));
    },
    rawLength: () => source.length,
    sizeChars: () => source.joinedLength(),
    setWidth(w) {
      width = w;
    },

    displayLength: () => derived().length,
    window(height) {
      const lines = derived();
      const start = state.scrollPos;
      const end = Math.min(lines.length, start + height);
      const matches = matchedLines();
      const hasQuery = state.searchQuery !== '';
      const current = state.searchMatches[state.currentMatch ?? -1];
      const g0 = state.gatherStart;
      const g1 = state.gatherEnd;
      const gLo = g0 !== null && g1 !== null ? Math.min(g0, g1) : 0;
      const gHi = g0 !== null && g1 !== null ? Math.max(g0, g1) : -1;
      const rows: WindowRow[] = [];
      for (let i = start; i < end; i++) {
        rows.push({
          index: i,
          number: i + 1,
          text: lines.at(i),
          match: hasQuery && matches.has(i) ? (current === i ? 'current' : 'match') : 'none',
          gathered: i >= gLo && i <= gHi,
        });
      }
      return {
        rows,
        scrollPos: start,
        displayLength: lines.length,
        totalDigits: String(lines.length).length,
      };
    },

    scrollUp(amount) {
      state.scrollPos = Math.max(0, state.scrollPos - amount);
    },
    scrollDown(amount, height) {
      const maxScroll = Math.max(0, source.length - height);
      state.scrollPos = Math.min(maxScroll, state.scrollPos + amount);
    },
    scrollToTop() {
      state.scrollPos = 0;
    },
    scrollToBottom(height) {
      state.scrollPos = Math.max(0, source.length - height);
    },

    setMode(mode) {
      state.viewerMode = mode;
      state.searchQuery = '';
      state.searchMatches = [];
      state.currentMatch = -1;
    },
    toggleWrap() {
      state.wordWrap = !state.wordWrap;
      state.scrollPos = 0;
    },
    toggleTabSize() {
      state.tabSize = state.tabSize === 4 ? 8 : 4;
    },

    search(query) {
      state.searchQuery = query;
      state.searchMatches = findMatches(query);
      state.currentMatch = state.searchMatches.length > 0 ? 0 : -1;
      if (state.searchMatches.length > 0) jumpToCurrentMatch();
    },
    nextMatch() {
      if (state.searchMatches.length === 0) return;
      state.currentMatch = (state.currentMatch + 1) % state.searchMatches.length;
      jumpToCurrentMatch();
    },
    prevMatch() {
      if (state.searchMatches.length === 0) return;
      state.currentMatch = state.currentMatch <= 0
        ? state.searchMatches.length - 1
        : state.currentMatch - 1;
      jumpToCurrentMatch();
    },

    gather(height) {
      if (state.gatherStart === null) {
        state.gatherStart = state.scrollPos;
        state.gatherEnd = null;
        return null;
      }
      state.gatherEnd = state.scrollPos + height - 1;
      const start = Math.min(state.gatherStart, state.gatherEnd);
      const end = Math.min(Math.max(state.gatherStart, state.gatherEnd), source.length - 1);
      return source.slice(start, end + 1).join('\n');
    },
    clearGather() {
      state.gatherStart = null;
      state.gatherEnd = null;
    },
    isGathering: () => state.gatherStart !== null,
  };
}
