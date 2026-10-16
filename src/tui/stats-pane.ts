import blessed from 'neo-blessed';
import { Colors, fg } from '../config/defaults.js';
import type { DiskStats } from '../fs/disk-stats.js';
import { formatStatsSize } from '../fs/dir-stats.js';

export interface StatsData {
  filespec: string;
  diskStats: DiskStats | null;
  totalFiles: number;
  totalBytes: number;
  matchingFiles: number;
  matchingBytes: number;
  taggedFiles: number;
  taggedBytes: number;
  currentDirName: string;
  currentDirFiles: number;
}

export interface StatsPane {
  widget: blessed.Widgets.BoxElement;
  refresh(data: StatsData): void;
  show(): void;
  hide(): void;
}

export function createStatsPane(screen: blessed.Widgets.Screen): StatsPane {
  const widget = blessed.box({
    parent: screen,
    label: ' Statistics ',
    left: '75%-1',
    top: 1,
    width: '25%+1',
    height: '100%-2',
    border: { type: 'line' },
    style: {
      bg: Colors.bg,
      border: { fg: Colors.border, bg: Colors.bg },
      label: { fg: Colors.titleFg, bg: Colors.bg, bold: true },
      fg: Colors.default,
    },
    tags: true,
    content: '',
  });

  // Start hidden — will be shown when display mode is 'dir'
  widget.hide();

  function formatNumber(n: number): string {
    return n.toLocaleString();
  }

  function refresh(data: StatsData): void {
    const diskName = data.diskStats?.device || 'unknown';
    const diskMount = data.diskStats?.mountpoint || '/';
    const available = data.diskStats?.available || '?';
    const totalDisk = data.diskStats?.total || '?';
    const usedPercent = data.diskStats?.percentUsed || '?';

    const lines = [
      '',
      `  ${fg('FILE  ', Colors.labelFg)}${fg(blessed.escape(data.filespec), Colors.valueFg)}`,
      '',
      `  ${fg('DISK', Colors.labelFg)}  ${fg(diskMount, Colors.valueFg)}`,
      `    ${fg('Available', Colors.labelFg)}`,
      `      ${fg(available, Colors.valueFg)}`,
      '',
      `  ${fg('DISK Statistics', Colors.labelFg)}`,
      `    ${fg('Total', Colors.labelFg)}`,
      `      ${fg('Files:', Colors.labelFg)}  ${fg(formatNumber(data.totalFiles), Colors.valueFg)}`,
      `      ${fg('Bytes:', Colors.labelFg)}  ${fg(formatStatsSize(data.totalBytes), Colors.valueFg)}`,
      `    ${fg('Matching', Colors.labelFg)}`,
      `      ${fg('Files:', Colors.labelFg)}  ${fg(formatNumber(data.matchingFiles), Colors.valueFg)}`,
      `      ${fg('Bytes:', Colors.labelFg)}  ${fg(formatStatsSize(data.matchingBytes), Colors.valueFg)}`,
      `    ${fg('Tagged', Colors.labelFg)}`,
      `      ${fg('Files:', Colors.labelFg)}  ${fg(formatNumber(data.taggedFiles), Colors.valueFg)}`,
      `      ${fg('Bytes:', Colors.labelFg)}  ${fg(formatStatsSize(data.taggedBytes), Colors.valueFg)}`,
      '',
      `  ${fg('Current Directory', Colors.labelFg)}`,
      `    ${fg(blessed.escape(data.currentDirName), Colors.valueFg)}`,
      `      ${fg('Files:', Colors.labelFg)}  ${fg(formatNumber(data.currentDirFiles), Colors.valueFg)}`,
    ];

    widget.setContent(lines.join('\n'));
  }

  function show(): void {
    widget.show();
  }

  function hide(): void {
    widget.hide();
  }

  return { widget, refresh, show, hide };
}
