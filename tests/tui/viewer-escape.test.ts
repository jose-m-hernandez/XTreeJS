// C-F1: the viewer draws file content and the file name with blessed tags on,
// so text that looks like a tag must be escaped to be shown as typed. These
// use real tag names ({bold}); an unknown brace is drawn literally anyway and
// would pass for the wrong reason. Rendered text is read from the screen's own
// cells (`screen.lines`), inside the viewer's region.

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { flush, press } from '../helpers/headless-screen.js';
import { contentRows, openFile, openLines, topBarText } from '../helpers/viewer-harness.js';

describe('C-F1: viewer escapes content and file name', () => {
  test('file content that looks like a tag is shown literally', () => {
    const rig = openLines(['{bold}x', 'plain', '{/bold}y {red-fg}z{/}']);
    try {
      expect(contentRows(rig.screen, 3)).toEqual([
        '1 {bold}x',
        '2 plain',
        '3 {/bold}y {red-fg}z{/}',
      ]);
    } finally {
      rig.destroy();
    }
  });

  test('a file named like a tag shows its name in the top bar', () => {
    const rig = openLines(['hello'], '/synthetic/{bold}n.txt');
    try {
      expect(topBarText(rig.screen)).toContain('Text: {bold}n.txt  Line 1/1');
    } finally {
      rig.destroy();
    }
  });

  test('a real file named like a tag, opened as the app opens it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtreejs-escape-'));
    try {
      const file = path.join(dir, '{bold}n.txt');
      fs.writeFileSync(file, '{bold}x\n');
      const rig = await openFile(file);
      try {
        expect(topBarText(rig.screen)).toContain('Text: {bold}n.txt');
        expect(contentRows(rig.screen, 1)).toEqual(['1 {bold}x']);
      } finally {
        rig.destroy();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a search highlight on tag-like text still shows it literally', async () => {
    const rig = openLines(['{bold}x', 'other']);
    try {
      press(rig.screen, 's');
      await flush(20);
      for (const c of '{bold}') press(rig.screen, c);
      press(rig.screen, 'enter');
      await flush(25);
      expect(rig.state.viewerState!.searchMatches).toEqual([0]);
      expect(contentRows(rig.screen, 1)).toEqual(['1 {bold}x']);
    } finally {
      rig.destroy();
    }
  });

  test('hex mode shows tag-like bytes literally in the text column', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtreejs-escape-'));
    try {
      const file = path.join(dir, 'tags.bin');
      fs.writeFileSync(file, '{bold}x');
      const rig = await openFile(file);
      try {
        await rig.key('h');
        expect(contentRows(rig.screen, 1)[0]).toEndWith('|{bold}x|');
      } finally {
        rig.destroy();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
