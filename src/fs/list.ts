import { $ } from 'bun';
import { getCachedTools } from './detect-tools.js';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  isExecutable: boolean;
  size: number;
  mtime: Date;
}

/**
 * Stats `fullPath` and builds a FileEntry for it, or returns null if it
 * can't be stat'd (e.g. a race with deletion, a broken symlink target).
 */
async function toFileEntry(fullPath: string, name: string): Promise<FileEntry | null> {
  try {
    const stat = await fs.lstat(fullPath);
    return {
      name,
      path: fullPath,
      isDirectory: stat.isDirectory(),
      isSymlink: stat.isSymbolicLink(),
      isExecutable: !stat.isDirectory() && (stat.mode & 0o111) !== 0,
      size: stat.size,
      mtime: stat.mtime,
    };
  } catch {
    return null;
  }
}

async function listWithFd(dirPath: string): Promise<FileEntry[]> {
  try {
    const result =
      await $`fd . ${dirPath} --max-depth 1 --type f --type d --color never`.text();
    const lines = result.trim().split('\n').filter(Boolean);

    const entries: FileEntry[] = [];
    for (const line of lines) {
      const fullPath = line.startsWith('/') ? line : path.resolve(dirPath, line);
      // Skip the directory itself
      if (path.resolve(fullPath) === path.resolve(dirPath)) continue;
      const entry = await toFileEntry(fullPath, path.basename(fullPath));
      if (entry) entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

async function listWithReaddir(dirPath: string): Promise<FileEntry[]> {
  try {
    const names = await fs.readdir(dirPath);
    const entries: FileEntry[] = [];

    for (const name of names) {
      const fullPath = path.join(dirPath, name);
      const entry = await toFileEntry(fullPath, name);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

import type { SortOrder, SortDirection } from '../types.js';

export function sortEntries(
  entries: FileEntry[],
  sortOrder: SortOrder = 'name',
  sortDirection: SortDirection = 'asc'
): FileEntry[] {
  if (sortOrder === 'unsorted') return entries;

  const sorted = [...entries];
  const dir = sortDirection === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    // Directories always sort first
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;

    let cmp = 0;
    switch (sortOrder) {
      case 'name':
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        break;
      case 'ext': {
        const extA = path.extname(a.name).toLowerCase();
        const extB = path.extname(b.name).toLowerCase();
        cmp = extA.localeCompare(extB);
        if (cmp === 0) {
          cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        }
        break;
      }
      case 'size':
        cmp = a.size - b.size;
        break;
      case 'date':
        cmp = a.mtime.getTime() - b.mtime.getTime();
        break;
    }
    return cmp * dir;
  });

  return sorted;
}

export function filterByFilespec(
  entries: FileEntry[],
  filespec: string
): FileEntry[] {
  if (!filespec || filespec === '*') return entries;

  const specs = filespec.trim().split(/\s+/);
  return entries.filter((entry) => {
    if (entry.isDirectory) return true; // always show directories
    return specs.some((spec) => matchFilespec(entry.name, spec));
  });
}

export function matchFilespec(name: string, spec: string): boolean {
  if (spec === '*') return true;
  // Convert filespec glob to regex: * -> .*, ? -> .
  const escaped = spec
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(name);
}

export async function listDirectory(
  dirPath: string,
  sortOrder: SortOrder = 'name',
  sortDirection: SortDirection = 'asc',
  filespec: string = '*'
): Promise<FileEntry[]> {
  const tools = getCachedTools();
  let entries: FileEntry[];

  if (tools?.fd) {
    entries = await listWithFd(dirPath);
    // fd might fail on certain dirs — fall back
    if (entries.length === 0) {
      entries = await listWithReaddir(dirPath);
    }
  } else {
    entries = await listWithReaddir(dirPath);
  }

  entries = filterByFilespec(entries, filespec);
  entries = sortEntries(entries, sortOrder, sortDirection);

  return entries;
}

export async function listDirectoryRecursive(
  dirPath: string,
  sortOrder: SortOrder = 'name',
  sortDirection: SortDirection = 'asc',
  filespec: string = '*'
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  async function walk(dir: string): Promise<void> {
    try {
      const names = await fs.readdir(dir);
      for (const name of names) {
        const fullPath = path.join(dir, name);
        const entry = await toFileEntry(fullPath, path.relative(dirPath, fullPath));
        if (!entry) continue;
        if (entry.isDirectory) {
          await walk(fullPath);
        } else {
          entries.push(entry);
        }
      }
    } catch {
      // Skip dirs we can't read
    }
  }

  await walk(dirPath);
  let filtered = filterByFilespec(entries, filespec);
  filtered = sortEntries(filtered, sortOrder, sortDirection);
  return filtered;
}

export async function listAllFilesRecursive(dirPath: string): Promise<string[]> {
  const paths: string[] = [];

  async function walk(dir: string): Promise<void> {
    try {
      const names = await fs.readdir(dir);
      for (const name of names) {
        const fullPath = path.join(dir, name);
        try {
          const stat = await fs.lstat(fullPath);
          if (stat.isDirectory()) {
            await walk(fullPath);
          } else {
            paths.push(fullPath);
          }
        } catch {
          // Skip
        }
      }
    } catch {
      // Skip
    }
  }

  await walk(dirPath);
  return paths;
}

export async function hasSubdirectories(dirPath: string): Promise<boolean> {
  try {
    const names = await fs.readdir(dirPath);
    for (const name of names) {
      try {
        const stat = await fs.lstat(path.join(dirPath, name));
        if (stat.isDirectory()) return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}
