# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and follows semantic versioning.

## [Unreleased]

## [0.1.1] - 2026-10-16

### Added

- Content-hash folder dedupe: core logic, tests and a CLI, plus a dry-run, read-only compare pane in the TUI. It replaces the earlier standalone dedup/merge scripts, which were dropped before release.
- `ARCHITECTURE.md` documenting the rationale for an off-the-shelf TUI framework and a shell-heavy filesystem layer, including the deliberate no-fallback exception for delete/prune.
- README screenshot, family-legacy motivation section, and CI/license badges.
- CI now runs `bunx tsc --noEmit` before the test step.
- Registered an `xtree` binary (`package.json` `bin` field, `#!/usr/bin/env bun` shebang on `src/index.ts`) so installing the package exposes a directly runnable `xtree` command. README documents `bun link` as the no-publish-required way to get it from a local clone.

### Changed

- Updated the terminal palette from generic ANSI yellow/blue to explicit gold on royal blue hex colors.
- Bumped the `bun`/`bun-types` devDependency pin from `^1.2.0` to `^1.3.8` to match the `engines`/CI requirement.
- Release workflow now also runs the typecheck step, matching CI.
- Downsized the README screenshot from a 3424px-wide Retina capture to 1440px (1.5M -> 512K) with no visible quality loss at its displayed width.
- DRY pass across `src/`: extracted shared helpers for FileEntry construction (`fs/list.ts`), viewFile* error handling (`fs/view.ts`), directory re-listing and the copy/move/delete result-handling tail (`index.ts`), and branch/showall mode toggling (`index.ts`). No behavior change.
- `AGENTS.md` is the contributor contract; `CLAUDE.md` is a one-line `@AGENTS.md` bridge. README opens with its purpose sentence.
- `setupInput` now takes `TreePane` directly instead of `index.ts` smuggling the raw widget through `(screen as any)._treeWidget`; the 7 call sites that re-derived the selected tree index now call `TreePane.getSelectedIndex()`.

### Fixed

- `tsc --noEmit` now typechecks `tests/` and `scripts/` too, not just `src/` — the `tsconfig.json` `include` list and CI's typecheck step previously left both directories unchecked (they're clean; this only closes the coverage gap).
- `scripts/release.ts` (validates every tag/version/changelog release gate) had no test coverage at all; added 7 subprocess-driven tests covering the `check`/`notes` commands' success and failure paths.
- Shift+J (toggle junk mode) in the viewer was unreachable dead code — blessed reports it as `key.name: 'j', key.shift: true`, not `'J'`, so it was always intercepted by the plain `j` scroll-down case before reaching the branch that handled it.
- `i` (invert tag) could skip an extra entry when untagging the current item in tagged-only view, because it advanced the cursor by comparing against the unfiltered entry count instead of the filtered one that `t`/`u` already used correctly. Extracted the shared, correct logic into `advanceSelectionAfterTagChange()` so the three call sites can't drift again.
- Tree pane no longer steals keyboard focus back from the file pane on every UI refresh (`setFocused(false)` was unconditionally calling `.focus()`).
- Viewer tab-size toggle (`t`) now actually re-expands tab characters instead of only updating the hint label.
- Tree node expand/collapse (`*`) no longer double-refreshes with stale data while an async expand is still in flight.
- Statistics pane now formats byte counts with compact units (K/M/G) instead of raw byte counts.
- `\` (and any other jump that skips intermediate directories, e.g. exiting branch/showall mode) no longer leaves the tree pane's highlighted row out of sync with the file pane's current directory.
- `tsc --noEmit` now passes cleanly (added a typed shim for neo-blessed's missing declarations).
- Corrected stale tool-fallback claims, a stale test count, and lingering `dust` references in `CLAUDE.md`/`README.md`/`ARCHITECTURE.md`/`TODO.md` that no longer matched the code.

## [0.1.0] - 2026-05-15

### Added

- Initial public pre-release of XTreeJS core functionality.
- Two-pane terminal UI with tree and file panes.
- Viewer mode with search/hex/wrap/follow support.
- Tagging, filespec filtering, recursive listing modes, and pattern rename.
- GitHub Actions CI and tag-driven release workflow.
- `ROADMAP.md` for outcome-based planning.
- `CONTRIBUTING.md`, `SECURITY.md`, and GitHub issue templates.
- Local release metadata checks and changelog-driven release note generation.

### Changed

- External editor flow now resumes the TUI instead of exiting the app process.
- CI pins Bun to `1.3.8` and uses `bun install --frozen-lockfile`.
- Release workflow runs tests, validates tag/version/changelog consistency, and uses the matching `CHANGELOG.md` entry as the GitHub Release body.
- GitHub Releases for `v0.x` tags are marked as prereleases.
- README reflects a Bun-first workflow and explicit release contract.

### Fixed

- Tagged-only view selection now targets the visible filtered entry instead of the same index in the unfiltered file list.
- Multi-file move now preflights destination conflicts before mutating sources.
- Rename now rejects path-like names so it cannot move files outside the current directory.

### Security

- `delete` and `prune` now require the `trash` CLI and do not fall back to destructive removal.
