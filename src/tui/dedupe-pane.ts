// Read-only scrollable overlay for showing a dedupe comparison report.
// Modeled on help-pane.ts's modal pattern -- this is intentionally NOT the
// file viewer (viewer-pane.ts), since the viewer's hex/ascii/search modes
// re-read the underlying file from disk by path, which a synthetic report
// has none of.

import blessed from 'neo-blessed';
import { Colors, fg } from '../config/defaults.js';
import { getKeyRouter, modalLayer } from './key-router.js';

export function showTextReport(
  screen: blessed.Widgets.Screen,
  title: string,
  lines: string[]
): Promise<void> {
  return new Promise((resolve) => {
    const width = Math.min(100, (screen.width as number) - 4);
    const height = Math.min(lines.length + 4, (screen.height as number) - 2);
    const content = `${lines.join('\n')}\n\n  ${fg('Press q or Esc to close', Colors.valueFg)}`;

    const box = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width,
      height,
      border: { type: 'line' },
      style: {
        bg: Colors.bg,
        fg: Colors.default,
        border: { fg: Colors.borderFocused, bg: Colors.bg },
        label: { fg: Colors.titleFg, bold: true },
      },
      label: ` ${title} `,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '█',
        style: { fg: Colors.border },
      },
      content,
    });

    screen.render();

    const router = getKeyRouter(screen);
    const layer = modalLayer((ch, key) => {
      if (key.name === 'q' || key.name === 'escape') {
        router.pop(layer);
        box.destroy();
        screen.render();
        resolve();
      } else if (key.name === 'up' || ch === 'k') {
        box.scroll(-1);
        screen.render();
      } else if (key.name === 'down' || ch === 'j') {
        box.scroll(1);
        screen.render();
      } else if (key.name === 'pageup') {
        box.scroll(-(height - 2));
        screen.render();
      } else if (key.name === 'pagedown') {
        box.scroll(height - 2);
        screen.render();
      }
    });
    router.push(layer);
  });
}

export function showBusyMessage(
  screen: blessed.Widgets.Screen,
  message: string
): () => void {
  const box = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: Math.min(60, (screen.width as number) - 4),
    height: 3,
    border: { type: 'line' },
    style: {
      bg: Colors.bg,
      fg: Colors.default,
      border: { fg: Colors.borderFocused, bg: Colors.bg },
    },
    tags: true,
    content: `\n  ${message}`,
  });
  screen.render();
  return () => {
    box.destroy();
    screen.render();
  };
}
