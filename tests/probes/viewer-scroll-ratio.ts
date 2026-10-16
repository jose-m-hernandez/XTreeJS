// Evidence, not a gate: how the cost of one viewer scroll grows with file size.
// Run with `bun run tests/probes/viewer-scroll-ratio.ts`. It is named without
// `.test` so `bun test` never picks it up; wall-clock numbers do not belong in
// the committed suite (the structural gates in tests/tui/viewer-structural.test.ts
// are the gate). Before and after ratios go in the PR body.
//
// Method: open the viewer headless on N synthetic lines, press `down` ten times,
// and take the best per-keystroke time of five rounds (min, to shed GC and
// scheduler noise). The ratio is the 200,000-line time over the 1,000-line time,
// in the same run, with and without word wrap.

import { openLines } from '../helpers/viewer-harness.js';
import { flush, press } from '../helpers/headless-screen.js';

const SIZES = [1000, 50_000, 200_000];
const ROUNDS = 5;
const KEYS = 10;

const lines = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => 'line\t' + i + ' some text here for width');

async function msPerKey(n: number, wrap: boolean): Promise<number> {
  const rig = openLines(lines(n));
  try {
    if (wrap) await rig.key('w');
    let best = Infinity;
    for (let r = 0; r < ROUNDS; r++) {
      await rig.key('home');
      const t = performance.now();
      for (let k = 0; k < KEYS; k++) press(rig.screen, 'down');
      const ms = (performance.now() - t) / KEYS;
      await flush();
      best = Math.min(best, ms);
    }
    return best;
  } finally {
    rig.destroy();
  }
}

for (const wrap of [false, true]) {
  const ms: Record<number, number> = {};
  for (const n of SIZES) {
    ms[n] = await msPerKey(n, wrap);
    console.log(`PROBE wrap=${wrap ? 'on ' : 'off'} lines=${String(n).padStart(7)}  ${ms[n].toFixed(2)} ms/keystroke`);
  }
  const ratio = ms[200_000] / ms[1000];
  console.log(`PROBE wrap=${wrap ? 'on ' : 'off'} ratio 200k/1k = ${ratio.toFixed(1)}x`);
}
