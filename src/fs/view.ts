import { $ } from 'bun';
import { getCachedTools } from './detect-tools.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ViewResult {
  lines: string[];
  totalLines: number;
}

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp',
  '.svg', '.ico', '.tiff', '.tif', '.avif', '.heic',
]);

export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function viewImage(
  filePath: string,
  cols: number,
  rows: number
): Promise<ViewResult> {
  const tools = getCachedTools();
  const stat = await fs.stat(filePath);
  const sizeStr = stat.size < 1024
    ? `${stat.size}B`
    : stat.size < 1024 * 1024
      ? `${(stat.size / 1024).toFixed(0)}K`
      : `${(stat.size / (1024 * 1024)).toFixed(1)}M`;

  const header = [
    `  Image: ${path.basename(filePath)}  (${sizeStr})`,
    '',
  ];

  if (tools?.chafa) {
    try {
      // Size chafa output to fit the viewer area (leave room for borders/bars)
      const w = Math.max(20, cols - 4);
      const h = Math.max(10, rows - 6);
      const result = await $`chafa --size=${w}x${h} --animate=off --color-space=din99d --symbols=block+border+space+extra --polite=on ${filePath}`
        .quiet().nothrow().text();
      const imageLines = result.split('\n');
      return {
        lines: [...header, ...imageLines],
        totalLines: header.length + imageLines.length,
      };
    } catch {
      // Fall through to fallback
    }
  }

  // No chafa — show file info and install hint
  const lines = [
    ...header,
    '  [Image preview not available]',
    '',
    `  File type: ${path.extname(filePath)}`,
    `  Size: ${sizeStr}`,
    '',
    '  Install chafa for terminal image preview:',
    '    brew install chafa',
  ];

  return { lines, totalLines: lines.length };
}

async function viewText(filePath: string): Promise<ViewResult> {
  const tools = getCachedTools();

  let content: string;
  if (tools?.bat) {
    const result =
      await $`bat --style=plain --color=always --paging=never ${filePath}`
        .text();
    content = result;
  } else {
    content = await fs.readFile(filePath, 'utf-8');
  }

  const lines = content.split('\n');
  return { lines, totalLines: lines.length };
}

export async function viewFile(
  filePath: string,
  cols: number = 80,
  rows: number = 24
): Promise<ViewResult> {
  try {
    if (isImageFile(filePath)) {
      return await viewImage(filePath, cols, rows);
    }
    return await viewText(filePath);
  } catch (err: any) {
    return {
      lines: [`Error reading file: ${err.message}`],
      totalLines: 1,
    };
  }
}

/**
 * Runs `build` and wraps its result lines as a ViewResult, or reports the
 * error as a single-line ViewResult if it throws — the shared shape every
 * viewFile* variant below needs.
 */
async function toViewResult(build: () => Promise<string[]>): Promise<ViewResult> {
  try {
    const lines = await build();
    return { lines, totalLines: lines.length };
  } catch (err: any) {
    return { lines: [`Error: ${err.message}`], totalLines: 1 };
  }
}

export const HEX_BYTES_PER_LINE = 16;

/** How many hex-dump lines `byteLength` bytes make. */
export function hexLineCount(byteLength: number): number {
  return Math.ceil(byteLength / HEX_BYTES_PER_LINE);
}

/** One hex-dump line (0-based `lineIndex`), built from only its own 16 bytes. */
export function hexLine(buffer: Uint8Array, lineIndex: number): string {
  const offset = lineIndex * HEX_BYTES_PER_LINE;
  const chunk = buffer.subarray(offset, offset + HEX_BYTES_PER_LINE);
  const hex = Array.from(chunk)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
  const ascii = Array.from(chunk)
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
    .join('');
  const offsetStr = offset.toString(16).padStart(8, '0').toUpperCase();
  return `${offsetStr}  ${hex.padEnd(HEX_BYTES_PER_LINE * 3 - 1)}  |${ascii}|`;
}

/**
 * The file's bytes, for building hex lines on demand, or the one-line error
 * result `viewFileHex` reports when the file cannot be read.
 */
export async function readHexBytes(
  filePath: string
): Promise<{ buffer: Buffer } | { error: ViewResult }> {
  try {
    return { buffer: await fs.readFile(filePath) };
  } catch (err: any) {
    return { error: { lines: [`Error: ${err.message}`], totalLines: 1 } };
  }
}

export function viewFileHex(filePath: string): Promise<ViewResult> {
  return toViewResult(async () => {
    const buffer = await fs.readFile(filePath);
    const lines: string[] = [];
    for (let i = 0; i < hexLineCount(buffer.length); i++) {
      lines.push(hexLine(buffer, i));
    }
    return lines;
  });
}

export function viewFileAscii(filePath: string): Promise<ViewResult> {
  return toViewResult(async () => (await fs.readFile(filePath, 'utf-8')).split('\n'));
}

export function viewFileJunk(filePath: string): Promise<ViewResult> {
  return toViewResult(async () => {
    const content = await fs.readFile(filePath, 'utf-8');
    // Replace non-printable chars (except newline, tab) with .
    const cleaned = content.replace(/[^\x20-\x7E\n\t]/g, '.');
    return cleaned.split('\n');
  });
}

export function searchInLines(lines: string[], query: string): number[] {
  if (!query) return [];
  const matches: number[] = [];
  const lowerQuery = query.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lowerQuery)) {
      matches.push(i);
    }
  }
  return matches;
}

export function expandTabs(line: string, tabSize: number): string {
  if (tabSize <= 0 || !line.includes('\t')) return line;
  let result = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const spaces = tabSize - (col % tabSize);
      result += ' '.repeat(spaces);
      col += spaces;
    } else {
      result += ch;
      col++;
    }
  }
  return result;
}

export function wrapLines(lines: string[], width: number): string[] {
  const result: string[] = [];
  for (const line of lines) {
    if (line.length <= width) {
      result.push(line);
    } else {
      for (let i = 0; i < line.length; i += width) {
        result.push(line.slice(i, i + width));
      }
    }
  }
  return result;
}
