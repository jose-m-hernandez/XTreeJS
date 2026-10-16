// The one place that listens for keystrokes.
//
// neo-blessed emits a screen 'keypress' and then a 'key <name>' event for the
// same keystroke. A modal that listened on 'keypress' and closed itself could
// not stop the second event, so the key that closed it also ran its normal
// action (q closed the viewer, then quit the app). Here there is a single
// listener and a stack of layers: a modal pushes a layer while it is open, the
// top layer sees each key first, and only when no layer takes the key does it
// reach the keymap.

import type blessed from 'neo-blessed';

export type KeyEvent = blessed.Widgets.Events.IKeyEventArg;
type Screen = blessed.Widgets.Screen;

export interface KeyLayer {
  /** Return true to consume the key; false lets it fall to the layer below. */
  handle(ch: string, key: KeyEvent): boolean;
}

export type KeyHandler = (ch: string, key: KeyEvent) => boolean | void | Promise<void>;

export interface KeyRouter {
  push(layer: KeyLayer): void;
  pop(layer: KeyLayer): void;
  depth(): number;
  /** Runs before any layer; return true to consume. Used for Ctrl+C. */
  setGlobal(handler: ((ch: string, key: KeyEvent) => boolean) | null): void;
  /** Runs when no layer consumed the key: the keymap dispatcher. */
  setBase(handler: KeyHandler | null): void;
  /** Receives a message for every callback or layer task that rejects or throws. */
  setErrorHandler(handler: ((message: string) => void) | null): void;
  /** Run a task, awaiting it; a rejection goes to the error handler. */
  run(task: () => void | Promise<void>): void;
}

const routers = new WeakMap<Screen, KeyRouter>();

/** The screen's router, created (and its listener attached) on first use. */
export function getKeyRouter(screen: Screen): KeyRouter {
  let router = routers.get(screen);
  if (!router) {
    router = createKeyRouter(screen);
    routers.set(screen, router);
  }
  return router;
}

/** A layer that takes every key, as a modal must. */
export function modalLayer(onKey: (ch: string, key: KeyEvent) => void): KeyLayer {
  return {
    handle(ch, key) {
      onKey(ch, key);
      return true;
    },
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function createKeyRouter(screen: Screen): KeyRouter {
  const stack: KeyLayer[] = [];
  let globalHandler: ((ch: string, key: KeyEvent) => boolean) | null = null;
  let baseHandler: KeyHandler | null = null;
  // Until something wires a status bar, a failure has nowhere to be shown.
  let onError: ((message: string) => void) | null = null;

  function report(err: unknown): void {
    onError?.(describe(err));
  }

  function run(task: () => void | Promise<void>): void {
    try {
      const result = task();
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).then(undefined, report);
      }
    } catch (err) {
      report(err);
    }
  }

  screen.on('keypress', (ch: string, key: KeyEvent) => {
    if (globalHandler && globalHandler(ch, key)) return;

    // Walk a copy: a layer commonly pops itself while handling the key.
    for (const layer of [...stack].reverse()) {
      if (layer.handle(ch, key)) return;
    }

    const base = baseHandler;
    if (base) run(() => base(ch, key) as void | Promise<void>);
  });

  return {
    push(layer) {
      stack.push(layer);
    },
    pop(layer) {
      const i = stack.lastIndexOf(layer);
      if (i !== -1) stack.splice(i, 1);
    },
    depth: () => stack.length,
    setGlobal(handler) {
      globalHandler = handler;
    },
    setBase(handler) {
      baseHandler = handler;
    },
    setErrorHandler(handler) {
      onError = handler;
    },
    run,
  };
}
