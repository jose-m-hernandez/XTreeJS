# XTreeJS

[![CI](https://github.com/jose-m-hernandez/XTreeJS/actions/workflows/ci.yml/badge.svg)](https://github.com/jose-m-hernandez/XTreeJS/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

XTreeJS is a keyboard-first terminal file manager modelled on the classic DOS program XTree, built with Bun and TypeScript. It is for people who like single-key commands and a tree-plus-file-list screen. The screen is checked on macOS, and the tests also run on Linux.

<p align="center">
  <img src="docs/screenshot.png" alt="XTreeJS running in a terminal" width="720">
</p>

This project is also a family legacy: my father, Henry Hernandez, co-founded Executive Systems Inc., the company that built the original XTree. XTreeGold was fast, direct, and opinionated in the best way — a small program that made a whole filesystem feel visible and alive. XTreeJS is a port and love letter, built for the joy of software and programming as much as for daily use.

<p align="center">
  <img src="https://upload.wikimedia.org/wikipedia/en/thumb/4/4c/Xtreegold-3.0.png/330px-Xtreegold-3.0.png" alt="XTreeGold 3.0 screenshot" width="360"><br>
  <em>For reference: the original XTreeGold 3.0, via <a href="https://en.wikipedia.org/wiki/XTree">Wikipedia</a>.</em>
</p>

## What it does

- Two panes: a directory tree on the left, the file list on the right, with a statistics pane and a hints bar.
- Single-key commands, with the XTree function keys alongside: `F3`/`v` view, `F5`/`c` copy, `F6`/`m` move, `F7`/`d` delete, `F8` prune, `t` tag, `s` sort, `f` filespec filter, `e`/`F4` open in `$EDITOR`, `?` help, `q` quit.
- A file viewer with search, a text/hex toggle, line wrap and follow mode.
- Tagging: one file, all files, by pattern, across directories.
- Delete and prune go to the system trash, never to a raw `rm`.
- `xtree dedupe compare <dirA> <dirB>` and `xtree dedupe merge <destDir> <sourceDir>...` compare or merge directory trees by file content. Run `xtree dedupe` for the full usage.

## What it does not do

- It is not built or tested for Windows.
- It does not use the mouse.
- It does not delete without `trash`: with no `trash` command installed, delete and prune refuse to run.
- It is pre-1.0 (current release `v0.1.1`); expect rough edges.

## Run it

Requires [Bun](https://bun.sh) 1.3.8 or newer and a UTF-8 terminal.

```bash
git clone https://github.com/jose-m-hernandez/XTreeJS.git
cd XTreeJS
bun install
bun run src/index.ts          # start in the current directory
bun run src/index.ts ~/Documents  # or in a directory you name
```

To get an `xtree` command, run `bun link` in the clone. It puts `xtree` in `~/.bun/bin`; if your shell can't find it, add `export PATH="$HOME/.bun/bin:$PATH"` to your shell profile. `bun unlink` reverses it.

### Optional tools

Delete and prune need a command named `trash` on your `PATH` (check with `command -v trash`; on macOS, `brew install trash` if it is missing). These are used when present and replaced by built-in code when not: `fd`, `bat`, `rsync`, `duf`, `chafa`.

## Develop

```bash
bun test            # tests
bunx tsc --noEmit   # typecheck
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the code is laid out and why, [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and release steps, and [CHANGELOG.md](CHANGELOG.md) for what changed. Contributions are welcome, especially testing on real systems.

## License

MIT. See [LICENSE](LICENSE).
