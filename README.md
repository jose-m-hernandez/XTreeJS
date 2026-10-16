# XTreeJS

[![CI](https://github.com/jozecuervo/XTreeJS/actions/workflows/ci.yml/badge.svg)](https://github.com/jozecuervo/XTreeJS/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

XTreeJS is a keyboard-first revival of the classic DOS file manager XTree, built with Bun and TypeScript.

<p align="center">
  <img src="docs/screenshot.png" alt="XTreeJS running in a terminal" width="720">
</p>

This project is also a family legacy: my father, Henry Hernandez, co-founded Executive Systems Inc., the company that built the original XTree. XTreeGold was fast, direct, and opinionated in the best way — a small program that made a whole filesystem feel visible and alive. XTreeJS is a port and love letter, built for the joy of software and programming as much as for daily use.

The goal is to keep the spirit and interaction model recognizable while making it useful in modern terminals. Contributions are welcome: help improve it, test it on real systems, and keep it true to form as a living port of the DOS classic.

<p align="center">
  <img src="https://upload.wikimedia.org/wikipedia/en/thumb/4/4c/Xtreegold-3.0.png/330px-Xtreegold-3.0.png" alt="XTreeGold 3.0 screenshot" width="360"><br>
  <em>For reference: the original XTreeGold 3.0, via <a href="https://en.wikipedia.org/wiki/XTree">Wikipedia</a>.</em>
</p>

## Status

`v0.1.0` is a pre-release milestone focused on core navigation, viewer, tagging, and safe file operations.

## Features

- Two-pane TUI layout (tree + file list)
- Single-key XTree-inspired navigation and actions
- File viewer with search, hex/ascii modes, wrap toggle, and follow mode
- Tagging workflows (single, bulk, global, pattern-based)
- Safe delete/prune via system trash CLI

## Architecture

Two layers, each delegating to a specialized dependency rather than
reinventing it: a [neo-blessed](https://github.com/embarklabs/neo-blessed)
TUI for rendering/input, and a shell-first filesystem layer (`fd`, `bat`,
`rsync`, `trash`, `chafa`) with native `fs` fallbacks where a tool isn't
installed. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full breakdown,
including the pros/cons behind each choice and the one place (delete/prune)
where a fallback is deliberately refused for safety.

## Requirements

- Bun 1.3.8+
- macOS/Linux terminal with UTF-8 support

Tool support:
- Required for safety-critical operations: `trash` (delete/prune).
- Optional (auto-detected): `fd`, `bat`, `rsync`, `duf`, `chafa`.

## Quick Start

```bash
bun install
bun test
bun run src/index.ts
```

### Install as a command

From a local clone, `bun link` registers an `xtree` binary (via the
`bin` field in `package.json`) with no publishing required:

```bash
bun link
xtree
```

This drops a symlink at `~/.bun/bin/xtree` pointing back at this
repo's `src/index.ts`. Make sure `~/.bun/bin` is on your `PATH` (the
Bun installer usually adds it to your shell profile) — if `xtree`
isn't found after linking, add `export PATH="$HOME/.bun/bin:$PATH"`
to your `~/.zshrc` or `~/.bashrc` and restart your shell. `bun unlink`
reverses it.

## Test Suite

```bash
bunx tsc --noEmit   # typecheck
bun test            # run the test suite
```

## Release Contract

1. CI must be green on `main`.
2. `CHANGELOG.md` must include a dated heading for the release version (`## [X.Y.Z] - YYYY-MM-DD`).
3. `package.json` version must match the Git tag (`vX.Y.Z`).
4. Run `bun run release:check vX.Y.Z` locally before tagging.
5. Push tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The release workflow re-runs the typecheck and test suite, validates tag/package/changelog alignment, and publishes the matching changelog entry as the GitHub Release body.

## License

MIT. See `LICENSE`.
