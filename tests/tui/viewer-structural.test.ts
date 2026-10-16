// The viewer's structural performance gates (CTO ruling 3: no wall-clock tests
// in `bun test`). Scrolling must do work proportional to the viewport, never to
// the file:
//   (a) a scroll runs zero expandTabs/wrapLines calls (the derived display
//       lines are cached, not recomputed per keystroke);
//   (b) one scroll at 200,000 lines hands the renderer no more lines than the
//       viewport holds, the same count as at 1,000, and processes no more.
// Two seams: the lines processed are counted at `expandTabs`/`wrapLines`
// (spied), and the lines handed to the renderer are counted where the viewer
// widget receives its content (`setContent` on the bordered box). On the base
// the box already receives only a viewport-sized slice; the cost is upstream,
// in the per-keystroke pass over every line, so gate (b) is red there on the
// processed count and the viewport check is the half that must stay green.
//
// The wall-clock ratio lives in tests/probes/viewer-scroll-ratio.ts, outside
// bun test's glob.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as view from '../../src/fs/view.js';
import { openLines, VIEWPORT_HEIGHT, type Rig } from '../helpers/viewer-harness.js';

let rig: Rig | null = null;
afterEach(() => {
  rig?.destroy();
  rig = null;
});

const makeLines = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => 'line\t' + i + ' some text here for width');

/** Record the line count of every setContent on the viewer's bordered box. */
function watchContent(r: Rig): number[] {
  const seen: number[] = [];
  for (const child of (r.screen as any).children) {
    if (!child.border) continue;
    const orig = child.setContent.bind(child);
    child.setContent = (content: string, ...rest: unknown[]) => {
      seen.push(String(content).split('\n').length);
      return orig(content, ...rest);
    };
  }
  return seen;
}

const SCROLL_KEYS = ['down', 'pagedown', 'end', 'up', 'pageup', 'home'];

describe('viewer scroll cost is structural', () => {
  for (const wrap of [false, true]) {
    test(`(a) scrolling calls expandTabs/wrapLines zero times (wrap ${wrap ? 'on' : 'off'})`, async () => {
      rig = openLines(makeLines(1000));
      if (wrap) await rig.key('w');
      const tabs = spyOn(view, 'expandTabs');
      const wraps = spyOn(view, 'wrapLines');
      try {
        for (const k of SCROLL_KEYS) await rig.key(k);
        expect(tabs.mock.calls.length).toBe(0);
        expect(wraps.mock.calls.length).toBe(0);
      } finally {
        tabs.mockRestore();
        wraps.mockRestore();
      }
    });
  }

  for (const wrap of [false, true]) {
    test(`(b) one scroll at 200,000 lines costs no more than at 1,000 (wrap ${wrap ? 'on' : 'off'})`, async () => {
      const measure = async (n: number) => {
        rig = openLines(makeLines(n));
        if (wrap) await rig.key('w');
        const content = watchContent(rig);
        const tabs = spyOn(view, 'expandTabs');
        const wraps = spyOn(view, 'wrapLines');
        try {
          await rig.key('down');
          const processed =
            tabs.mock.calls.length +
            wraps.mock.calls.reduce((sum, c) => sum + (c[0] as string[]).length, 0);
          return { handed: Math.max(...content), renders: content.length, processed };
        } finally {
          tabs.mockRestore();
          wraps.mockRestore();
          rig.destroy();
          rig = null;
        }
      };
      const small = await measure(1000);
      const large = await measure(200_000);
      expect(small.renders).toBe(1);
      expect(large.renders).toBe(1);
      // The renderer gets one window, never more than the viewport holds.
      expect(small.handed).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
      expect(large.handed).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
      expect(large.handed).toBe(small.handed);
      // And no per-line work beyond the window was done to produce it.
      expect(large.processed).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
      expect(large.processed).toBe(small.processed);
    });
  }
});
