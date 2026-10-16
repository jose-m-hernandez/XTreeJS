import { $ } from 'bun';
import { getCachedTools } from './detect-tools.js';
import { formatSize } from '../util/format.js';

export interface DiskStats {
  device: string;
  mountpoint: string;
  total: string;
  used: string;
  available: string;
  percentUsed: string;
}

let cachedStats: DiskStats | null = null;
let cachedPath: string = '';
let cachedTime: number = 0;
const CACHE_TTL = 30_000; // 30 seconds

export async function getDiskStats(dirPath: string): Promise<DiskStats> {
  const now = Date.now();
  if (cachedStats && cachedPath === dirPath && now - cachedTime < CACHE_TTL) {
    return cachedStats;
  }

  const tools = getCachedTools();

  if (tools?.duf) {
    try {
      const result = await $`duf --json ${dirPath}`.quiet().nothrow().text();
      const data = JSON.parse(result);
      if (Array.isArray(data) && data.length > 0) {
        const d = data[0];
        cachedStats = {
          device: d.device || 'unknown',
          mountpoint: d.mount_point || '/',
          total: formatSize(d.total),
          used: formatSize(d.used),
          available: formatSize(d.free),
          percentUsed: `${((d.used / d.total) * 100).toFixed(0)}%`,
        };
        cachedPath = dirPath;
        cachedTime = now;
        return cachedStats;
      }
    } catch {
      // Fall through to df
    }
  }

  // Fallback: parse df output
  try {
    const result = await $`df -h ${dirPath}`.quiet().nothrow().text();
    const lines = result.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      // df output: Filesystem Size Used Avail Capacity Mount
      cachedStats = {
        device: parts[0] || 'unknown',
        mountpoint: parts[parts.length - 1] || '/',
        total: parts[1] || '?',
        used: parts[2] || '?',
        available: parts[3] || '?',
        percentUsed: parts[4] || '?',
      };
      cachedPath = dirPath;
      cachedTime = now;
      return cachedStats;
    }
  } catch {
    // Can't get disk stats
  }

  return {
    device: 'unknown',
    mountpoint: '/',
    total: '?',
    used: '?',
    available: '?',
    percentUsed: '?',
  };
}

export function clearDiskStatsCache(): void {
  cachedStats = null;
  cachedPath = '';
  cachedTime = 0;
}
