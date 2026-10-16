# XTreeJS TODO

A modern revival of the classic DOS-era XTree file manager (1985-1995), built with Bun + TypeScript + neo-blessed. Both a practical tool and a family legacy tribute -- Jose's father Henry Hernandez co-founded Executive Systems Inc., the company behind XTree.

Updated based on the original XTree / XTreePro Gold / XTreeGold manual reference.

**Test suite:** 175 tests passing
**Planning:** Strategic milestones live in `ROADMAP.md`; this file tracks implementation tasks.

---

## Done (P0)

- [x] Two-pane layout (tree left, files right) with status bars
- [x] Filesystem listing via fd (fallback to readdir)
- [x] Tree pane with expand/collapse (+/-/*)
- [x] Tab navigation between panes
- [x] Tagging system (t/T/u/U)
- [x] File operations: copy (F5/c), move/rename (F6/m), delete via trash (F7/d), prune (F8)
- [x] File viewer with bat syntax highlighting (F3/v)
- [x] Image preview via chafa in viewer
- [x] Arrow key navigation, Enter/Backspace directory traversal
- [x] XTree-inspired gold on royal blue color scheme
- [x] Confirmation dialogs (delete, prune with double-confirm)

---

## Done (P1 -- Authentic XTree Behavior)

### Display & Layout

- [x] **Enter cycles display modes** -- pressing Enter cycles: directory window -> small file window -> expanded file window
- [x] **Disk statistics bar (top)** -- show drive, volume, total/available space, file count via duf/df
- [x] **Command bar context switching** -- bottom bar shows different commands based on mode
- [x] **F2 redraw/refresh** -- force screen redraw

### File Operations (matching original keys)

- [x] **Attribute viewer (a)** -- view/change file permissions
- [x] **Rename (n or r)** -- rename highlighted file/directory
- [x] **Makedir (m in dir mode)** -- create new subdirectory when tree pane focused
- [x] **Invert tag (i)** -- toggle tag on current file
- [x] **Ctrl+I invert all tags** -- invert all tags across current view
- [x] **External editor (e/F4)** -- open file in $EDITOR, suspending and resuming the TUI around it

### Viewer (matching original)

- [x] **Hex dump view (h or d)** -- hex + ASCII side-by-side display
- [x] **Search in viewer (s or F9)** -- search for text, Space for next match
- [x] **Word wrap toggle (w)** -- toggle word wrapping in viewer
- [x] **Tab size toggle (t in viewer)** -- toggle between 4 and 8 space tabs, re-expanding existing tab characters
- [x] **ASCII/Junk mode (a/j)** -- raw ASCII view and strip-non-printable mode

### Sorting & Filtering

- [x] **Sort cycle (s in file mode)** -- cycle: name, extension, date, size, unsorted
- [x] **Sort ascending/descending** -- toggle sort direction
- [x] **Filespec filter (f)** -- wildcard filter (e.g. `*.ts`, `*.md`), space-separated multiple specs
- [x] **Ctrl+F toggle filespec** -- quickly toggle between last two filespec entries
- [x] **Shift+Letter speed navigation** -- jump to next entry starting with that letter

### Tree Navigation (matching original)

- [x] **Right arrow deep-dive** -- in tree, Right arrow follows path to deepest subdirectory
- [x] **Backtick (`` ` ``) between sibling dirs** -- jump to next directory at same indentation level
- [x] **Home goes to root** -- in tree, Home jumps to root of tree

### Help

- [x] **Help screen (? or F1)** -- context-sensitive help overlay showing available commands for current mode
- [x] **F10 quick reference** -- condensed command reference card

### Not implemented from P1

- [ ] **Extended statistics (? or /)** -- detailed disk/directory/file stats overlay (`?` was mapped to help instead)

---

## Done (Post-P1)

- [x] **Directory statistics in tree** -- show file count and size per directory in tree pane (via `dir-stats.ts`)
- [x] **Volume root tree** -- tree starts at volume root
- [x] **Image viewer quality** -- improved chafa rendering

---

## Done (P2 -- Power Features)

Features from later XTree versions (Gold/Pro Gold) that add real power.

### Input & History

- [x] **Input prompt history** -- Up arrow recalls previous inputs for copy dest, filespec, etc. (keyed by prompt type)
- [x] **F3 paste last response** -- quickly re-use last input value
- [x] **Ctrl+Backspace clear line** -- erase input and move cursor to beginning

### Branch / Showall Modes

- [x] **Branch mode (b)** -- show all files under current directory and all subdirectories recursively
- [x] **Showall mode (s in tree pane)** -- show all files matching filespec across entire tree
- [x] **Backslash in branch/showall** -- jump to the parent directory of highlighted file, exit special mode

### Advanced Tagging

- [x] **Tag by filespec (+/-)** -- tag or untag all files matching a glob pattern
- [x] **Ctrl+T / Ctrl+U** -- tag/untag ALL files across entire tree (not just current dir)
- [x] **Ctrl+G show tagged only** -- filter view to show only tagged files (Ctrl+G fallback for Ctrl+F4)
- [x] **Pattern rename (Ctrl+N)** -- rename all tagged files using glob pattern substitution

### Viewer Enhancements

- [x] **Remember scroll position per file** -- restore position when re-opening a previously viewed file
- [x] **Follow/tail mode (f)** -- auto-scroll and watch for new lines (for logs), disabled on manual scroll up
- [x] **Gather/copy text (g)** -- mark range with two g presses, copy to clipboard via pbcopy

### Not implemented from P2

### Autoview & Split Screen

- [ ] **Autoview (F7)** -- preview pane that auto-updates as you move through file list
- [ ] **Shift+keys in autoview** -- scroll/change mode in preview pane without leaving file list
- [ ] **Split screen (F8)** -- dual independent panels, copy/move between them

### File Operations Enhancements

- [ ] **Progress bars for operations** -- show progress during copy/move of large files
- [ ] **Alt+C / Alt+M preserve paths** -- copy/move tagged files keeping directory structure
- [ ] **eXecute (x)** -- drop to shell or run highlighted file
- [ ] **Jump to directory (\ or j)** -- Treespec: type a path and jump directly to it, with history

---

## P3 -- Modern Enhancements

Features that go beyond the original XTree, taking advantage of modern tools and terminals.

### Developer Experience

- [ ] **Git status indicators** -- show modified/untracked/staged markers next to files in file list
- [ ] **LLM-friendly helpers** -- copy tagged file paths or file contents to clipboard for use with AI tools
- [ ] **Syntax-aware directory colors** -- color directories based on project type (git repos, node projects, etc.)

### Content-Hash Dedupe

Grew out of a real cleanup job: multiple old backup copies of a folder tree where filenames/dates alone couldn't say whether the content actually matched. `src/fs/dedupe.ts` treats a file as a duplicate only when its SHA-256 matches exactly, ignoring filesystem noise (`.DS_Store`, AppleDouble `._*`, `thumbs.db`); any path that disagrees across sources is surfaced as a conflict rather than silently resolved by picking a side.

- [x] **Core scan/compare/merge-plan logic** (`src/fs/dedupe.ts`) -- `scanTree`, `compareManifests`, `isRedundant`, `planMerge`, `executeMergePlan`
- [x] **Non-interactive CLI** -- `xtree dedupe compare <a> <b>` and `xtree dedupe merge <dest> <src...>` (`src/cli/dedupe-cli.ts`), usable in scripts without the TUI
- [x] **TUI compare (dry run, read-only)** -- Ctrl+D on a selected directory prompts for a second path, hashes both trees, and shows the comparison in a scrollable report pane (`src/tui/dedupe-pane.ts`). Never writes anything.
- [ ] **TUI merge (write path)** -- deliberately not wired up yet; the dry-run compare shipped first so merge behavior (dest prompt, conflict handling, confirmation) can be designed and reviewed before anything in the TUI writes files
- [ ] **Progress feedback for large trees** -- hashing thousands of files can take a while; the compare pane currently shows only a static "scanning" message, not incremental progress
- [ ] **Merge conflict resolution UI** -- browse `(CONFLICT-<source>)` pairs side by side and pick one interactively, instead of leaving both for manual cleanup

### Platform & Display

- [ ] **Windows support** -- cross-platform compatibility
- [ ] **Built-in viewer** -- remove external bat dependency, native syntax highlighting
- [ ] **Image preview improvements** -- sixel protocol for high-fidelity terminal images
- [ ] **Configurable color schemes** -- multiple themes like original XTree's 30 predefined schemes

### Performance & Operations

- [ ] **Parallel background operations** -- async copy/move with progress, non-blocking UI
- [ ] **Partial/lazy tree loading** -- load tree branches on demand for huge filesystems

### Configuration

- [ ] **Custom key remapping** -- user-defined keybindings via config file
- [ ] **Startup options** -- command-line switches matching original XTree (--sort, --filespec, etc.)
- [ ] **Persistent state** -- save/restore last directory, tags, sort order across sessions (Alt+Z behavior)
- [ ] **Application menu (F9)** -- customizable launcher for external tools with parameter substitution
