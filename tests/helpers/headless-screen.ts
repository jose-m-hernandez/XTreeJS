// A real neo-blessed screen on in-memory streams, so tests can drive the
// production key handling without a TTY. `press` injects at the same point a
// real keystroke enters: program 'keypress', which the screen turns into its
// own 'keypress' and then 'key <full>' events.

import { PassThrough } from 'stream';
import blessed from 'neo-blessed';

export interface HeadlessScreen {
  screen: blessed.Widgets.Screen;
  destroy(): void;
}

export function createHeadlessScreen(): HeadlessScreen {
  const input = new PassThrough() as any;
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough() as any;
  output.isTTY = true;
  output.columns = 120;
  output.rows = 40;
  // Nothing reads the output; drain it so the stream never backs up.
  output.on('data', () => {});

  const screen = blessed.screen({
    input,
    output,
    terminal: 'xterm',
    warnings: false,
  } as any);

  return {
    screen,
    destroy() {
      try {
        screen.destroy();
      } catch {
        // already destroyed
      }
    },
  };
}

export interface PressOptions {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

// What a terminal delivers as `ch` for the named (non-printable) keys.
const NAMED_CH: Record<string, string | undefined> = {
  tab: '\t',
  enter: '\r',
  return: '\r',
  escape: '\x1b',
  space: ' ',
  backspace: '\x7f',
};

/**
 * Emit one keystroke. `name` is a blessed key name ('q', 'up', 'f5', 'tab'),
 * or a single punctuation character ('+', '?', '\\'), which blessed reports
 * with no name and the character in `ch`. `{ shift: true }` on a letter is
 * Shift+letter: blessed gives name 'q', shift true, full 'S-q'.
 */
export function press(
  screen: blessed.Widgets.Screen,
  name: string,
  opts: PressOptions = {}
): void {
  const { ctrl = false, shift = false, meta = false } = opts;
  const isLetter = /^[a-z]$/.test(name);
  const isPunct = name.length === 1 && !isLetter;

  let ch: string | undefined;
  let keyName: string | undefined = name;
  if (isPunct) {
    ch = name;
    keyName = undefined;
  } else if (isLetter) {
    ch = ctrl ? String.fromCharCode(name.charCodeAt(0) - 96) : shift ? name.toUpperCase() : name;
  } else {
    ch = NAMED_CH[name];
  }

  const full =
    (ctrl ? 'C-' : '') + (meta ? 'M-' : '') + (shift && keyName ? 'S-' : '') + (keyName || ch);
  const key = { sequence: ch ?? '', name: keyName, ctrl, meta, shift, full };
  (screen.program as any).emit('keypress', ch, key);
}

/** Let promise continuations queued by a key handler run. */
export function flush(ms = 15): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The text actually drawn on the screen, one string per row. */
export function screenText(screen: blessed.Widgets.Screen): string[] {
  return (screen as any).lines.map((row: any[]) => row.map((c) => c[1]).join(''));
}
