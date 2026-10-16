#!/usr/bin/env bun
import * as path from 'path';
import { createScreen } from './tui/screen.js';
import { detectTools } from './fs/detect-tools.js';
import { setupInput } from './tui/input.js';
import { Defaults } from './config/defaults.js';
import { runDedupeCommand } from './cli/dedupe-cli.js';
import { createApp } from './app/app.js';
import { createCommands } from './app/commands.js';

async function main() {
  // Non-interactive subcommands bypass the TUI entirely.
  const args = process.argv.slice(2);
  if (args[0] === 'dedupe') {
    const code = await runDedupeCommand(args.slice(1));
    process.exit(code);
  }

  // Detect available tools first
  await detectTools();

  const startPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : Defaults.startPath;

  const screen = createScreen();
  const app = await createApp(screen, startPath);
  const p = app.activePanel();

  // Set up input handling
  setupInput(screen, p.state, p.treeState, p.treePane, createCommands(app), (message) => {
    // A handler that rejected: show why on the bottom bar; the next refresh restores the hints.
    app.statusBar.updateBottomHints(`Error: ${message}`);
  });

  // Initial load
  await p.loadDirectory(startPath);
  await p.updateDiskInfo(startPath);

  // Start in dir mode with tree focused (matching original XTree)
  p.state.focusPane = 'tree';
  p.treePane.widget.focus();
  p.treePane.setFocused(true);
  p.filePane.setFocused(false);

  screen.render();

  // Compute directory stats before first render so they appear immediately
  await p.computeTreeStats();
  app.refreshUI();
}

main().catch((err) => {
  console.error('XTreeJS fatal error:', err);
  process.exit(1);
});
