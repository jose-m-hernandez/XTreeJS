// Types shared across layers. They live here, not in state/, so that src/fs
// can use them without importing from src/state.
export type SortOrder = 'name' | 'ext' | 'size' | 'date' | 'unsorted';
export type SortDirection = 'asc' | 'desc';
