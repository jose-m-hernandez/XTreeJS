import blessed from 'neo-blessed';
import { Colors } from '../config/defaults.js';
import type { AppState, ViewerMode } from '../state/app-state.js';
import {
  viewFile, viewFileAscii, viewFileJunk, readHexBytes,
} from '../fs/view.js';
import { showSearchPrompt } from './prompt.js';
import { getKeyRouter, modalLayer, type KeyLayer } from './key-router.js';
import { createViewerModel, defaultViewerState, type ViewerModel } from './viewer-model.js';
import { render, renderBottomBar, renderTopBar } from './viewer-renderer.js';

export interface ViewerPane {
  show(lines: string[], filePath: string): void;
  hide(): void;
  scrollUp(amount: number): void;
  scrollDown(amount: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
  isVisible(): boolean;
}

// Scroll position cache (persists across viewer open/close)
const scrollPositionCache = new Map<string, number>();
const MAX_CACHE_SIZE = 200;

export function getScrollCache(): Map<string, number> {
  return scrollPositionCache;
}

export function clearScrollCache(): void {
  scrollPositionCache.clear();
}

// The viewer as a modal: it creates and destroys the widgets, owns the key
// layer, and maps each key onto the model (viewer-model.ts); the renderer
// (viewer-renderer.ts) draws it. It holds no viewer state of its own.
export function createViewerPane(
  screen: blessed.Widgets.Screen,
  state: AppState,
  onExit: () => void
): ViewerPane {
  let viewerBox: blessed.Widgets.BoxElement | null = null;
  let topBar: blessed.Widgets.BoxElement | null = null;
  let bottomBar: blessed.Widgets.BoxElement | null = null;
  let model: ViewerModel | null = null;
  let visible = false;
  let followTimer: ReturnType<typeof setInterval> | null = null;
  let keyLayer: KeyLayer | null = null;

  function getVisibleHeight(): number {
    if (!viewerBox) return 20;
    return (viewerBox.height as number) - 2; // minus border
  }

  function updateContent(): void {
    if (!viewerBox || !topBar || !bottomBar || !model) return;
    // Wrap width: the box less the line-number margin and border.
    model.setWidth((viewerBox.width as number) - 10);
    render(viewerBox, model, getVisibleHeight());
    renderTopBar(topBar, model);
    renderBottomBar(bottomBar, model);
    screen.render();
  }

  async function switchMode(mode: ViewerMode): Promise<void> {
    const m = model;
    if (!m) return;
    m.setMode(mode);

    const cols = (screen.width as number) || 80;
    const rows = (screen.height as number) || 24;
    if (mode === 'hex') {
      const bytes = await readHexBytes(m.filePath);
      if (model !== m) return;
      if ('error' in bytes) m.loadText(bytes.error.lines);
      else m.loadHex(bytes.buffer);
    } else {
      let result;
      switch (mode) {
        case 'ascii':
          result = await viewFileAscii(m.filePath);
          break;
        case 'junk':
          result = await viewFileJunk(m.filePath);
          break;
        default:
          result = await viewFile(m.filePath, cols, rows);
          break;
      }
      if (model !== m) return;
      m.loadText(result.lines);
    }
    m.scrollToTop();
    updateContent();
  }

  function stopFollow(): void {
    if (followTimer) {
      clearInterval(followTimer);
      followTimer = null;
    }
    if (model) {
      model.state.followMode = false;
    }
  }

  function startFollow(): void {
    const m = model;
    if (!m) return;
    m.state.followMode = true;
    followTimer = setInterval(async () => {
      if (!visible || model !== m) {
        stopFollow();
        return;
      }
      const cols = (screen.width as number) || 80;
      const rows = (screen.height as number) || 24;
      const result = await viewFile(m.filePath, cols, rows);
      if (model !== m) return;
      m.loadText(result.lines);
      m.scrollToBottom(getVisibleHeight());
      updateContent();
    }, 1000);
  }

  function setupKeys(m: ViewerModel): void {
    const keyHandler = async (
      ch: string,
      key: blessed.Widgets.Events.IKeyEventArg
    ) => {
      if (!visible) return;
      const vs = m.state;

      switch (key.name) {
        case 'up':
        case 'k':
          if (vs.followMode) stopFollow();
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
            await switchMode(vs.viewerMode === 'junk' ? 'text' : 'junk');
          }
          break;
        case 'pageup':
          if (vs.followMode) stopFollow();
          scrollUp(getVisibleHeight());
          break;
        case 'pagedown':
          scrollDown(getVisibleHeight());
          break;
        case 'space':
          if (!vs.searchQuery) scrollDown(getVisibleHeight());
          else nextMatch();
          break;
        case 'home':
          if (vs.followMode) stopFollow();
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
          if (m.isGathering()) {
            m.clearGather();
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
            await switchMode(vs.viewerMode === 'hex' ? 'text' : 'hex');
          } else if (ch === 's' || key.name === 'f9') {
            // Search
            const query = await showSearchPrompt(screen);
            if (query) m.search(query);
            updateContent(); // re-render after the prompt closes
          } else if (ch === 'n') {
            if (!key.shift) {
              nextMatch();
            } else {
              prevMatch();
            }
          } else if (ch === 'N') {
            prevMatch();
          } else if (ch === 'w') {
            m.toggleWrap();
            updateContent();
          } else if (ch === 't') {
            m.toggleTabSize();
            updateContent();
          } else if (ch === 'a') {
            await switchMode(vs.viewerMode === 'ascii' ? 'text' : 'ascii');
          } else if (ch === 'f') {
            // Follow/tail mode toggle
            if (vs.followMode) {
              stopFollow();
            } else {
              startFollow();
            }
            updateContent();
          } else if (ch === 'g') {
            // Gather mode: the first press marks the start, the second copies.
            const gathered = m.gather(getVisibleHeight());
            if (gathered !== null) {
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
              m.clearGather();
            }
            updateContent();
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
    if (!model) return;
    model.nextMatch();
    updateContent();
  }

  function prevMatch(): void {
    if (!model) return;
    model.prevMatch();
    updateContent();
  }

  function show(fileLines: string[], fp: string): void {
    // The model works on the app's own viewerState, so there is one copy.
    const m = createViewerModel(state.viewerState ?? defaultViewerState(fp, fileLines), fp);
    m.loadText(fileLines);
    // Restore scroll position from cache if available, clamped to the file
    m.state.scrollPos = Math.min(
      scrollPositionCache.get(fp) ?? 0,
      Math.max(0, fileLines.length - 1)
    );
    model = m;
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

    setupKeys(m);
    updateContent();
  }

  function hide(): void {
    // Save scroll position to cache before hiding
    if (model && model.filePath) {
      scrollPositionCache.set(model.filePath, model.state.scrollPos);
      // Evict oldest entries if cache is too large
      if (scrollPositionCache.size > MAX_CACHE_SIZE) {
        const firstKey = scrollPositionCache.keys().next().value;
        if (firstKey) scrollPositionCache.delete(firstKey);
      }
    }
    stopFollow();
    visible = false;
    model = null;
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
    if (!model) return;
    model.scrollUp(amount);
    updateContent();
  }

  function scrollDown(amount: number): void {
    if (!model) return;
    model.scrollDown(amount, getVisibleHeight());
    updateContent();
  }

  function scrollToTop(): void {
    if (!model) return;
    model.scrollToTop();
    updateContent();
  }

  function scrollToBottom(): void {
    if (!model) return;
    model.scrollToBottom(getVisibleHeight());
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
