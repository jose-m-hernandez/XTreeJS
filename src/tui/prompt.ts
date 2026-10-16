import blessed from 'neo-blessed';
import { Colors, fg } from '../config/defaults.js';
import type { FileAttributes } from '../fs/operations.js';
import { getKeyRouter, modalLayer, type KeyLayer } from './key-router.js';

// Prompt history keyed by prompt type
const promptHistories = new Map<string, string[]>();
const MAX_HISTORY = 50;
let lastPromptResponse = '';

export function getHistory(key: string): string[] {
  return promptHistories.get(key) ?? [];
}

export function addToHistory(key: string, value: string): void {
  if (!value) return;
  let history = promptHistories.get(key);
  if (!history) {
    history = [];
    promptHistories.set(key, history);
  }
  // Remove duplicate if exists
  const idx = history.indexOf(value);
  if (idx !== -1) history.splice(idx, 1);
  // Add to front
  history.unshift(value);
  // Cap at max
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
}

export function clearAllHistory(): void {
  promptHistories.clear();
  lastPromptResponse = '';
}

export function getLastPromptResponse(): string {
  return lastPromptResponse;
}

export function showPrompt(
  screen: blessed.Widgets.Screen,
  title: string,
  defaultValue: string = '',
  historyKey?: string
): Promise<string | null> {
  return new Promise((resolve) => {
    const promptBox = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '70%',
      height: 5,
      border: { type: 'line' },
      style: {
        border: { fg: Colors.borderFocused },
        bg: Colors.promptBg,
        fg: Colors.promptFg,
      },
      label: ` ${title} `,
      tags: true,
    });

    const input = blessed.textbox({
      parent: promptBox,
      top: 1,
      left: 1,
      right: 1,
      height: 1,
      style: {
        bg: Colors.inputBg,
        fg: Colors.inputFg,
      },
      inputOnFocus: true,
    } as any);

    input.setValue(defaultValue);
    screen.render();
    input.focus();
    input.readInput(() => {});

    // History navigation state
    const history = historyKey ? getHistory(historyKey) : [];
    let historyIndex = -1;
    let savedInput = defaultValue;

    // The textbox grabs the keyboard (screen.grabKeys), which stops the screen
    // from emitting keys at all, so history keys must be bound on the textbox
    // itself. The layer keeps any key that does reach the screen away from the
    // keymap while the prompt is open.
    const router = getKeyRouter(screen);
    const layer: KeyLayer = modalLayer(() => {});
    router.push(layer);

    // Intercept keypresses for history and special keys
    const keyHandler = (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
      if (key.name === 'up' && history.length > 0) {
        if (historyIndex === -1) {
          savedInput = input.getValue();
        }
        if (historyIndex < history.length - 1) {
          historyIndex++;
          input.setValue(history[historyIndex]);
          screen.render();
        }
      } else if (key.name === 'down' && historyIndex >= 0) {
        historyIndex--;
        if (historyIndex < 0) {
          input.setValue(savedInput);
        } else {
          input.setValue(history[historyIndex]);
        }
        screen.render();
      } else if (key.name === 'f3') {
        if (lastPromptResponse) {
          input.setValue(lastPromptResponse);
          screen.render();
        }
      } else if (key.name === 'backspace' && key.ctrl) {
        input.setValue('');
        screen.render();
      }
    };

    input.on('keypress', keyHandler);

    input.on('submit', (value: string) => {
      router.pop(layer);
      promptBox.destroy();
      screen.render();
      if (value && historyKey) {
        addToHistory(historyKey, value);
      }
      if (value) {
        lastPromptResponse = value;
      }
      resolve(value || null);
    });

    input.on('cancel', () => {
      router.pop(layer);
      promptBox.destroy();
      screen.render();
      resolve(null);
    });
  });
}

export function showConfirm(
  screen: blessed.Widgets.Screen,
  message: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const confirmBox = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '60%',
      height: 5,
      border: { type: 'line' },
      style: {
        border: { fg: Colors.errorFg },
        bg: Colors.promptBg,
        fg: Colors.promptFg,
      },
      label: ' Confirm ',
      tags: true,
      content: `\n ${message}\n\n ${fg('y', Colors.valueFg)} = Yes   ${fg('n', Colors.valueFg)}/${fg('Esc', Colors.valueFg)} = No`,
    });

    screen.render();

    // Any key answers the confirm, and the key is spent doing so.
    const router = getKeyRouter(screen);
    const layer = modalLayer((ch, key) => {
      router.pop(layer);
      confirmBox.destroy();
      screen.render();
      resolve(key.name === 'y' || ch === 'y' || ch === 'Y');
    });
    router.push(layer);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function showAttributes(
  screen: blessed.Widgets.Screen,
  fileName: string,
  attrs: FileAttributes
): Promise<string | null> {
  return new Promise((resolve) => {
    const type = attrs.isDirectory ? 'Directory' : attrs.isSymlink ? 'Symlink' : 'File';
    const content = [
      '',
      `  Name:         ${fileName}`,
      `  Type:         ${type}`,
      `  Size:         ${formatSize(attrs.size)}`,
      `  Permissions:  ${attrs.permissions} (octal)`,
      `  Owner/Group:  ${attrs.owner}/${attrs.group}`,
      `  Modified:     ${attrs.mtime.toLocaleString()}`,
      `  Accessed:     ${attrs.atime.toLocaleString()}`,
      '',
      `  ${fg('c', Colors.valueFg)} = Change permissions   ${fg('Esc', Colors.valueFg)} = Close`,
    ].join('\n');

    const box = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '65%',
      height: 13,
      border: { type: 'line' },
      style: {
        border: { fg: Colors.borderFocused },
        bg: Colors.promptBg,
        fg: Colors.promptFg,
      },
      label: ' File Attributes ',
      tags: true,
      content,
    });

    screen.render();

    const router = getKeyRouter(screen);
    const layer = modalLayer((ch, key) => {
      if (key.name === 'escape' || key.name === 'q') {
        router.pop(layer);
        box.destroy();
        screen.render();
        resolve(null);
      } else if (ch === 'c' || ch === 'C') {
        router.pop(layer);
        box.destroy();
        screen.render();
        resolve('chmod');
      }
    });
    router.push(layer);
  });
}

export function showSearchPrompt(
  screen: blessed.Widgets.Screen
): Promise<string | null> {
  return showPrompt(screen, 'Search for:', '', 'search');
}
