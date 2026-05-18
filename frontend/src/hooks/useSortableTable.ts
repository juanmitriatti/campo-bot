import { useState, useMemo } from 'react';

export type SortDirection = 'asc' | 'desc';
export interface SortState<K extends string = string> {
  key: K;
  direction: SortDirection;
}

/**
 * Client-side sort for table rows. Sorts within the current page; if you
 * need cross-page sort, route the sort key/direction through the API.
 *
 * Usage:
 *   const { sorted, sortState, toggleSort } = useSortableTable(rows, {
 *     getValue: (row, key) => ...
 *   });
 *   <th onClick={() => toggleSort('amount')}>Monto {arrow('amount')}</th>
 */
export function useSortableTable<T, K extends string = string>(
  rows: T[],
  opts: {
    getValue: (row: T, key: K) => string | number | Date | null | undefined;
    initial?: SortState<K>;
  },
) {
  const [sortState, setSortState] = useState<SortState<K> | null>(opts.initial ?? null);

  const sorted = useMemo(() => {
    if (!sortState) return rows;
    const { key, direction } = sortState;
    const dir = direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = opts.getValue(a, key);
      const bv = opts.getValue(b, key);
      // Push null/undefined to the end regardless of direction
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, sortState, opts]);

  const toggleSort = (key: K) => {
    setSortState(prev => {
      if (!prev || prev.key !== key) return { key, direction: 'asc' };
      if (prev.direction === 'asc') return { key, direction: 'desc' };
      return null; // 3rd click → unsorted
    });
  };

  const arrow = (key: K): string => {
    if (!sortState || sortState.key !== key) return '';
    return sortState.direction === 'asc' ? ' ▲' : ' ▼';
  };

  return { sorted, sortState, toggleSort, arrow };
}
