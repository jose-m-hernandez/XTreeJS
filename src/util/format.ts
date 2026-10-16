// Human-readable byte size: `512B`, `4K`, `1.5M`, `2.0G`. The one formatter
// for the file pane and the disk stats; the dir-stats and prompt formatters
// print differently on purpose and stay where they are.
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}
