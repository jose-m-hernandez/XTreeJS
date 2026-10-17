# AGENTS.md

This file provides guidance to Claude Code, Codex and other agents when working with code in this repository.

## Project Overview

XTreeJS is a modern revival of the classic DOS-era XTree file manager (1985–1995), built with **Bun + TypeScript** using **blessed/neo-blessed** for the terminal UI. It combines nostalgic single-key-driven UX with modern developer features like syntax highlighting and safe file operations.

## Tech Stack

- **Runtime:** Bun (not Node)
- **Language:** TypeScript
- **TUI Framework:** blessed / neo-blessed
- **External CLI tools:** `fd` (listing), `bat` (syntax-highlighted viewing), `rsync` (copy/move), `trash` (safe delete), `dust`/`duf` (disk stats), `chafa` (image preview) — each has a native `fs`/`child_process` fallback except `trash`

## Build & Run Commands

```bash
bun install          # install dependencies
bun run start        # launch XTreeJS (src/index.ts)
bun test             # run test suite
bun run <script>     # run any package.json script
```

## Architecture

The app follows a shell-heavy approach — it delegates filesystem operations to fast external CLI tools rather than reimplementing them in JS.

**Core layers:**
- **TUI layer** — blessed/neo-blessed widgets, layout, keybindings, colors (DOS-era palette)
- **Command dispatcher** — single-key handler with mode awareness (normal mode vs viewer mode)
- **App state** — current path, tagged files, sort order, filespec filter, selection position, viewer state
- **Filesystem layer** — spawns external tools (fd, bat, rsync, trash, dust/duf, chafa)
- **Cache** — directory listings, file sizes, mtimes, tagged paths

See `ARCHITECTURE.md` for the rationale behind these choices (why an off-the-shelf TUI framework, why shell out instead of reimplementing in TypeScript, and the deliberate exception for delete/prune safety).

**Two primary modes:**
1. **Normal mode** — two-pane layout (tree left, file list right) with navigation, tagging, and file actions
2. **Viewer mode** — syntax-highlighted file viewing via bat, with search, hex toggle, and scroll

## Design Principles

- **Single-key commands** — minimize modifier keys; frequent actions should be one keypress
- **Always-visible layout** — tree pane (left) + file list (right) + status/command bars (top/bottom)
- **Safe by default** — deletes use `trash` (moves to macOS Trash), never `rm -rf`
- **Performance targets** — startup < 400ms, responsive with 10k–50k items in a directory
- **Nostalgic feel** — DOS color palette (cyan dirs, green exes, red hidden), pseudo-graphic tree lines, information-dense layout
- **No floating windows or mouse usage** — preserve the 1985–1995 terminal atmosphere

## Key Bindings Reference

| Key | Action |
|-----|--------|
| `t` / `T` | Tag toggle / tag all |
| `u` / `U` | Untag / untag all |
| `F3` / `v` | Open viewer |
| `F5` / `c` | Copy |
| `F6` / `m` | Move/rename |
| `F7` / `d` | Delete (via trash) |
| `F8` | Prune |
| `s` | Sort cycle |
| `f` | Filespec filter |
| `e` / `F4` | External editor |
| `q` / `x` | Quit |
| `?` | Help |

## External Tool Dependencies

Install them with Homebrew (macOS):

```bash
brew install fd bat trash rsync dust duf chafa
```

Only `trash` is a hard requirement, and only for delete/prune (by design, no
fallback to a raw `rm`). Every other tool — including `fd` and `bat` — has a
native `fs`/`child_process` fallback and degrades gracefully if missing.
