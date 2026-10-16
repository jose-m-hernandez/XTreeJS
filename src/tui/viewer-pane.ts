import blessed from 'neo-blessed';
import { bgFg, Colors, fg } from '../config/defaults.js';
import type { AppState, ViewerMode } from '../state/app-state.js';
import {
  viewFile, viewFileHex, viewFileAscii, viewFileJunk,
  searchInLines, wrapLines, expandTabs,
} from '../fs/view.js';
import { showSearchPrompt } from './prompt.js';
import { getKeyRouter, modalLayer, type KeyLayer } from './key-router.js';
import * as path from 'path';

export interface ViewerPane {
  show(lines: string[], filePath: string): void;
  hide(): void;
  scrollUp(amount: number): void;
  scrollDown(amount: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
  isVisible(): boolean;
}

const MODE_LABELS: Record<ViewerMode, string> = {
  text: 'Text',
  hex: 'Hex',
  ascii: 'ASCII',
  junk: 'Junk',
};

// Scroll position cache (persists across viewer open/close)
const scrollPositionCache = new Map<string, number>();
const MAX_CACHE_SIZE = 200;

export function getScrollCache(): Map<string, number> {
  return scrollPositionCache;
}

export function clearScrollCache(): void {
  scrollPositionCache.clear();
}

function buildViewerHints(vs: AppState['viewerState']): string {
  const parts = ['↑↓ Scroll', 'PgUp/PgDn Page', 'Home/End Jump'];
  parts.push(`h Hex`);
  parts.push(`s Search`);
  if (vs?.searchMatches && vs.searchMatches.length > 0) {
    parts.push(`n Next  N Prev`);
  }
  parts.push(`w Wrap`);
  parts.push(`t Tab(${vs?.tabSize ?? 4})`);
  parts.push(`f Follow`);
  parts.push(`g Gather`);
  parts.push(`a ASCII  j Junk`);
  parts.push(`q/Esc Exit`);
  return parts.join('  ');
}

export function createViewerPane(
  screen: blessed.Widgets.Screen,
  state: AppState,
  onExit: () => void
): ViewerPane {
  let viewerBox: blessed.Widgets.BoxElement | null = null;
  let topBar: blessed.Widgets.BoxElement | null = null;
  let bottomBar: blessed.Widgets.BoxElement | null = null;
  let lines: string[] = [];
  let scrollPos = 0;
  let filePath = '';
  let visible = false;
  let followTimer: ReturnType<typeof setInterval> | null = null;
  let keyLayer: KeyLayer | null = null;

  function getVisibleHeight(): number {
    if (!viewerBox) return 20;
    return (viewerBox.height as number) - 2; // minus border
  }

  function updateContent(): void {
    if (!viewerBox || !topBar || !bottomBar) return;
    const vs = state.viewerState;
    const height = getVisibleHeight();

    let displayLines = lines;
    if (vs?.tabSize) {
      displayLines = displayLines.map((line) => expandTabs(line, vs.tabSize));
    }
    if (vs?.wordWrap) {
      const width = (viewerBox.width as number) - 10; // margin for line numbers + border
      displayLines = wrapLines(displayLines, Math.max(20, width));
    }

    const visibleLines = displayLines.slice(scrollPos, scrollPos + height);

    // Add line numbers + search highlighting
    const totalDigits = String(displayLines.length).length;
    const searchQuery = vs?.searchQuery || '';
    const searchMatches = vs?.searchMatches || [];
    const currentMatchIdx = vs?.currentMatch ?? -1;

    const numbered = visibleLines.map((line, i) => {
      const lineIdx = scrollPos + i;
      const lineNum = String(lineIdx + 1).padStart(totalDigits, ' ');
      let displayLine = line;

      // Highlight search matches
      if (searchQuery && searchMatches.includes(lineIdx)) {
        const isCurrentMatch = searchMatches[currentMatchIdx] === lineIdx;
        const highlightBg = isCurrentMatch ? Colors.taggedBg : Colors.selectionBg;
        const lowerLine = displayLine.toLowerCase();
        const lowerQuery = searchQuery.toLowerCase();
        let result = '';
        let pos = 0;
        while (pos < displayLine.length) {
          const idx = lowerLine.indexOf(lowerQuery, pos);
          if (idx === -1) {
            result += displayLine.slice(pos);
            break;
          }
          result += displayLine.slice(pos, idx);
          result += bgFg(
            displayLine.slice(idx, idx + searchQuery.length),
            highlightBg,
            Colors.selectionFg
          );
          pos = idx + searchQuery.length;
        }
        displayLine = result;
      }

      // Highlight gather range
      if (vs?.gatherStart !== null && vs?.gatherStart !== undefined) {
        if (vs.gatherEnd !== null && vs.gatherEnd !== undefined) {
          const start = Math.min(vs.gatherStart, vs.gatherEnd);
          const end = Math.max(vs.gatherStart, vs.gatherEnd);
          if (lineIdx >= start && lineIdx <= end) {
            return bgFg(`${lineNum} ${displayLine}`, Colors.selectionBg, Colors.selectionFg);
          }
        } else if (lineIdx >= vs.gatherStart && lineIdx <= scrollPos + height - 1) {
          // Show from gatherStart to current position as tentative highlight
        }
      }

      return `${fg(lineNum, Colors.valueFg)} ${displayLine}`;
    });

    viewerBox.setContent(numbered.join('\n'));

    const fileName = path.basename(filePath);
    const size = lines.join('\n').length;
    const sizeStr =
      size < 1024
        ? `${size}B`
        : size < 1024 * 1024
          ? `${(size / 1024).toFixed(0)}K`
          : `${(size / (1024 * 1024)).toFixed(1)}M`;
    const modeLabel = vs ? MODE_LABELS[vs.viewerMode] : 'Text';
    const wrapLabel = vs?.wordWrap ? ' Wrap' : '';
    const followLabel = vs?.followMode ? ` ${fg('FOLLOW', Colors.valueFg)}` : '';
    const gatherLabel = vs?.gatherStart !== null && vs?.gatherStart !== undefined
      ? `  ${fg(`GATHER from line ${vs.gatherStart + 1}`, Colors.valueFg)}`
      : '';
    const searchInfo = searchMatches.length > 0
      ? `  [${currentMatchIdx + 1}/${searchMatches.length}]`
      : '';
    topBar.setContent(
      ` ${modeLabel}${wrapLabel}${followLabel}: ${fileName}  Line ${scrollPos + 1}/${displayLines.length}  ${sizeStr}${searchInfo}${gatherLabel}  ${filePath}`
    );

    bottomBar.setContent(` ${buildViewerHints(vs)}`);

    screen.render();
  }

  async function switchMode(mode: ViewerMode): Promise<void> {
    if (!state.viewerState) return;
    state.viewerState.viewerMode = mode;
    state.viewerState.searchQuery = '';
    state.viewerState.searchMatches = [];
    state.viewerState.currentMatch = -1;

    let result;
    const cols = (screen.width as number) || 80;
    const rows = (screen.height as number) || 24;
    switch (mode) {
      case 'hex':
        result = await viewFileHex(filePath);
        break;
      case 'ascii':
        result = await viewFileAscii(filePath);
        break;
      case 'junk':
        result = await viewFileJunk(filePath);
        break;
      default:
        result = await viewFile(filePath, cols, rows);
        break;
    }
    lines = result.lines;
    state.viewerState.lines = lines;
    state.viewerState.totalLines = result.totalLines;
    scrollPos = 0;
    state.viewerState.scrollPos = 0;
    updateContent();
  }

  function stopFollow(): void {
    if (followTimer) {
      clearInterval(followTimer);
      followTimer = null;
    }
    if (state.viewerState) {
      state.viewerState.followMode = false;
    }
  }

  function startFollow(): void {
    if (!state.viewerState) return;
    state.viewerState.followMode = true;
    followTimer = setInterval(async () => {
      if (!visible || !state.viewerState) {
        stopFollow();
        return;
      }
      const cols = (screen.width as number) || 80;
      const rows = (screen.height as number) || 24;
      const result = await viewFile(filePath, cols, rows);
      lines = result.lines;
      state.viewerState.lines = lines;
      state.viewerState.totalLines = result.totalLines;
      // Scroll to bottom
      scrollPos = Math.max(0, lines.length - getVisibleHeight());
      state.viewerState.scrollPos = scrollPos;
      updateContent();
    }, 1000);
  }

  function setupKeys(): void {
    const keyHandler = async (
      ch: string,
      key: blessed.Widgets.Events.IKeyEventArg
    ) => {
      if (!visible) return;
      const vs = state.viewerState;

      switch (key.name) {
        case 'up':
        case 'k':
          if (vs?.followMode) stopFollow();
          scrollUp(1);
          break;
        case 'down':
          scrollDown(1);
          break;
        case 'j':
          // blessed reports Shift+J as key.name 'j' with key.shift set
          // (not 'J'), so it lands in this case too -- toggle junk mode.
          if (!key.shift) scrollDown(1);
          else {
            await switchMode(vs?.viewerMode === 'junk' ? 'text' : 'junk');
          }
          break;
        case 'pageup':
          if (vs?.followMode) stopFollow();
          scrollUp(getVisibleHeight());
          break;
        case 'pagedown':
          scrollDown(getVisibleHeight());
          break;
        case 'space':
          if (!vs?.searchQuery) scrollDown(getVisibleHeight());
          else nextMatch();
          break;
        case 'home':
          if (vs?.followMode) stopFollow();
          scrollToTop();
          break;
        case 'end':
          scrollToBottom();
          break;
        case 'q':
          hide();
          onExit();
          break;
        case 'escape':
          // If gathering, cancel gather instead of exiting
          if (vs && vs.gatherStart !== null) {
            vs.gatherStart = null;
            vs.gatherEnd = null;
            updateContent();
          } else {
            hide();
            onExit();
          }
          break;
        default:
          // Handle character-based keys
          if (ch === 'h' || ch === 'd') {
            // Toggle hex mode
            const newMode = vs?.viewerMode === 'hex' ? 'text' : 'hex';
            await switchMode(newMode);
          } else if (ch === 's' || key.name === 'f9') {
            // Search
            const query = await showSearchPrompt(screen);
            if (query && vs) {
              vs.searchQuery = query;
              vs.searchMatches = searchInLines(lines, query);
              vs.currentMatch = vs.searchMatches.length > 0 ? 0 : -1;
              if (vs.searchMatches.length > 0) {
                scrollPos = vs.searchMatches[0];
                vs.scrollPos = scrollPos;
              }
              updateContent();
            } else {
              updateContent(); // re-render after prompt closes
            }
          } else if (ch === 'n') {
            if (!key.shift) {
              nextMatch();
            } else {
              prevMatch();
            }
          } else if (ch === 'N') {
            prevMatch();
          } else if (ch === 'w') {
            if (vs) {
              vs.wordWrap = !vs.wordWrap;
              scrollPos = 0;
              vs.scrollPos = 0;
              updateContent();
            }
          } else if (ch === 't') {
            if (vs) {
              vs.tabSize = vs.tabSize === 4 ? 8 : 4;
              updateContent();
            }
          } else if (ch === 'a') {
            await switchMode(vs?.viewerMode === 'ascii' ? 'text' : 'ascii');
          } else if (ch === 'f') {
            // Follow/tail mode toggle
            if (vs?.followMode) {
              stopFollow();
            } else {
              startFollow();
            }
            updateContent();
          } else if (ch === 'g') {
            // Gather mode
            if (vs) {
              if (vs.gatherStart === null) {
                // First press: mark start
                vs.gatherStart = scrollPos;
                vs.gatherEnd = null;
                updateContent();
              } else {
                // Second press: mark end and copy
                vs.gatherEnd = scrollPos + getVisibleHeight() - 1;
                const start = Math.min(vs.gatherStart, vs.gatherEnd);
                const end = Math.min(Math.max(vs.gatherStart, vs.gatherEnd), lines.length - 1);
                const gathered = lines.slice(start, end + 1).join('\n');
                // Copy to clipboard via pbcopy
                try {
                  const proc = Bun.spawn(['pbcopy'], {
                    stdin: 'pipe',
                  });
                  proc.stdin.write(gathered);
                  proc.stdin.end();
                  await proc.exited;
                } catch {
                  // clipboard copy failed silently
                }
                vs.gatherStart = null;
                vs.gatherEnd = null;
                updateContent();
              }
            }
          }
          break;
      }
    };

    // The viewer is a modal: it takes every key while open, and its work (which
    // may await a prompt or a file read) runs under the router so a failure is
    // reported rather than dropped.
    const router = getKeyRouter(screen);
    keyLayer = modalLayer((ch, key) => router.run(() => keyHandler(ch, key)));
    router.push(keyLayer);
  }

  function nextMatch(): void {
    const vs = state.viewerState;
    if (!vs || vs.searchMatches.length === 0) return;
    vs.currentMatch = (vs.currentMatch + 1) % vs.searchMatches.length;
    scrollPos = vs.searchMatches[vs.currentMatch];
    vs.scrollPos = scrollPos;
    updateContent();
  }

  function prevMatch(): void {
    const vs = state.viewerState;
    if (!vs || vs.searchMatches.length === 0) return;
    vs.currentMatch = vs.currentMatch <= 0
      ? vs.searchMatches.length - 1
      : vs.currentMatch - 1;
    scrollPos = vs.searchMatches[vs.currentMatch];
    vs.scrollPos = scrollPos;
    updateContent();
  }

  function show(fileLines: string[], fp: string): void {
    lines = fileLines;
    filePath = fp;
    // Restore scroll position from cache if available
    scrollPos = scrollPositionCache.get(fp) ?? 0;
    // Clamp to valid range
    scrollPos = Math.min(scrollPos, Math.max(0, lines.length - 1));
    visible = true;

    topBar = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: {
        bg: Colors.statusBarBg,
        fg: Colors.statusBarFg,
        bold: true,
      },
      tags: true,
    });

    viewerBox = blessed.box({
      parent: screen,
      top: 1,
      left: 0,
      width: '100%',
      height: '100%-2',
      border: { type: 'line' },
      style: {
        bg: Colors.bg,
        border: { fg: Colors.border, bg: Colors.bg },
        fg: Colors.default,
      },
      scrollable: false,
      tags: true,
    });

    bottomBar = blessed.box({
      parent: screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: {
        bg: Colors.statusBarBg,
        fg: Colors.statusBarFg,
      },
      tags: true,
    });

    setupKeys();
    updateContent();
  }

  function hide(): void {
    // Save scroll position to cache before hiding
    if (filePath) {
      scrollPositionCache.set(filePath, scrollPos);
      // Evict oldest entries if cache is too large
      if (scrollPositionCache.size > MAX_CACHE_SIZE) {
        const firstKey = scrollPositionCache.keys().next().value;
        if (firstKey) scrollPositionCache.delete(firstKey);
      }
    }
    stopFollow();
    visible = false;
    if (viewerBox) {
      viewerBox.destroy();
      viewerBox = null;
    }
    if (topBar) {
      topBar.destroy();
      topBar = null;
    }
    if (bottomBar) {
      bottomBar.destroy();
      bottomBar = null;
    }
    if (keyLayer) {
      getKeyRouter(screen).pop(keyLayer);
      keyLayer = null;
    }
    screen.render();
  }

  function scrollUp(amount: number): void {
    scrollPos = Math.max(0, scrollPos - amount);
    if (state.viewerState) state.viewerState.scrollPos = scrollPos;
    updateContent();
  }

  function scrollDown(amount: number): void {
    const maxScroll = Math.max(0, lines.length - getVisibleHeight());
    scrollPos = Math.min(maxScroll, scrollPos + amount);
    if (state.viewerState) state.viewerState.scrollPos = scrollPos;
    updateContent();
  }

  function scrollToTop(): void {
    scrollPos = 0;
    if (state.viewerState) state.viewerState.scrollPos = 0;
    updateContent();
  }

  function scrollToBottom(): void {
    scrollPos = Math.max(0, lines.length - getVisibleHeight());
    if (state.viewerState) state.viewerState.scrollPos = scrollPos;
    updateContent();
  }

  return {
    show,
    hide,
    scrollUp,
    scrollDown,
    scrollToTop,
    scrollToBottom,
    isVisible: () => visible,
  };
}
