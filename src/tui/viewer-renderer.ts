// Draws the viewer's model into its widgets. It holds no state: `render` draws
// one window (what `model.window(height)` returns), and the two bar functions
// draw the top and bottom bars. Everything that came from a file (a line of
// content, the file name, the path) goes through `blessed.escape`, because the
// widgets have tags on and a name or line such as `{bold}x` must be shown as
// typed, not applied as markup.

import blessed from 'neo-blessed';
import * as path from 'path';
import { bgFg, Colors, fg } from '../config/defaults.js';
import type { ViewerMode, ViewerState } from '../state/app-state.js';
import type { ViewerModel, WindowRow } from './viewer-model.js';

const MODE_LABELS: Record<ViewerMode, string> = {
  text: 'Text',
  hex: 'Hex',
  ascii: 'ASCII',
  junk: 'Junk',
};

function buildViewerHints(vs: ViewerState): string {
  const parts = ['↑↓ Scroll', 'PgUp/PgDn Page', 'Home/End Jump'];
  parts.push(`h Hex`);
  parts.push(`s Search`);
  if (vs.searchMatches.length > 0) {
    parts.push(`n Next  N Prev`);
  }
  parts.push(`w Wrap`);
  parts.push(`t Tab(${vs.tabSize})`);
  parts.push(`f Follow`);
  parts.push(`g Gather`);
  parts.push(`a ASCII  j Junk`);
  parts.push(`q/Esc Exit`);
  return parts.join('  ');
}

/** The row's text escaped, with each occurrence of the query drawn highlighted. */
function drawText(row: WindowRow, query: string): string {
  if (row.match === 'none') return blessed.escape(row.text);

  const highlightBg = row.match === 'current' ? Colors.taggedBg : Colors.selectionBg;
  const lowerLine = row.text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let result = '';
  let pos = 0;
  while (pos < row.text.length) {
    const idx = lowerLine.indexOf(lowerQuery, pos);
    if (idx === -1) {
      result += blessed.escape(row.text.slice(pos));
      break;
    }
    result += blessed.escape(row.text.slice(pos, idx));
    result += bgFg(
      blessed.escape(row.text.slice(idx, idx + query.length)),
      highlightBg,
      Colors.selectionFg
    );
    pos = idx + query.length;
  }
  return result;
}

/** Draw one window of `model` (at most `height` lines) into the content box. */
export function render(box: blessed.Widgets.BoxElement, model: ViewerModel, height: number): void {
  const win = model.window(height);
  const query = model.state.searchQuery;
  const lines = win.rows.map((row) => {
    const lineNum = String(row.number).padStart(win.totalDigits, ' ');
    const text = drawText(row, query);
    if (row.gathered) {
      return bgFg(`${lineNum} ${text}`, Colors.selectionBg, Colors.selectionFg);
    }
    return `${fg(lineNum, Colors.valueFg)} ${text}`;
  });
  box.setContent(lines.join('\n'));
}

export function renderTopBar(bar: blessed.Widgets.BoxElement, model: ViewerModel): void {
  const vs = model.state;
  const size = model.sizeChars();
  const sizeStr =
    size < 1024
      ? `${size}B`
      : size < 1024 * 1024
        ? `${(size / 1024).toFixed(0)}K`
        : `${(size / (1024 * 1024)).toFixed(1)}M`;
  const wrapLabel = vs.wordWrap ? ' Wrap' : '';
  const followLabel = vs.followMode ? ` ${fg('FOLLOW', Colors.valueFg)}` : '';
  const gatherLabel = vs.gatherStart !== null
    ? `  ${fg(`GATHER from line ${vs.gatherStart + 1}`, Colors.valueFg)}`
    : '';
  const searchInfo = vs.searchMatches.length > 0
    ? `  [${vs.currentMatch + 1}/${vs.searchMatches.length}]`
    : '';
  const fileName = blessed.escape(path.basename(model.filePath));
  bar.setContent(
    ` ${MODE_LABELS[vs.viewerMode]}${wrapLabel}${followLabel}: ${fileName}  Line ${vs.scrollPos + 1}/${model.displayLength()}  ${sizeStr}${searchInfo}${gatherLabel}  ${blessed.escape(model.filePath)}`
  );
}

export function renderBottomBar(bar: blessed.Widgets.BoxElement, model: ViewerModel): void {
  bar.setContent(` ${buildViewerHints(model.state)}`);
}
