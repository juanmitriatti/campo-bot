import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api/client';

export type CategoryKind = 'expense' | 'income';

export interface Category {
  id: number;
  kind: CategoryKind;
  name: string;
  usageCount: number;
  lastUsedAt: string | null;
}

interface ListResponse { categories: Category[]; }

export interface SimilarCategoryResponse {
  similar: { id: number; name: string; usageCount: number };
  proposedName: string;
  created: false;
}

export interface CreatedCategoryResponse {
  category: Category;
  created: true;
}

export type CreateResult = SimilarCategoryResponse | CreatedCategoryResponse;

export interface DuplicatePair {
  keep: { id: number; name: string; usageCount: number };
  drop: { id: number; name: string; usageCount: number };
}

interface DuplicatesResponse { pairs: DuplicatePair[]; }

export function useCategories(kind: CategoryKind) {
  const [data, setData] = useState<Category[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicatePair[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, dupes] = await Promise.all([
        apiRequest<ListResponse>(`/categories?kind=${kind}`),
        apiRequest<DuplicatesResponse>(`/categories/duplicates?kind=${kind}`).catch(() => ({ pairs: [] })),
      ]);
      setData(list.categories);
      setDuplicates(dupes.pairs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar categorías');
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async (name: string, opts: { confirmAsNew?: boolean } = {}): Promise<CreateResult> => {
    const r = await apiRequest<CreateResult>('/categories', {
      method: 'POST',
      body: { kind, name, ...(opts.confirmAsNew ? { confirmAsNew: true } : {}) },
    });
    if (r.created) {
      await refresh();
    }
    return r;
  }, [kind, refresh]);

  const rename = useCallback(async (id: number, name: string) => {
    await apiRequest(`/categories/${id}`, { method: 'PATCH', body: { name } });
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: number, reassignTo?: number) => {
    const qs = reassignTo ? `?reassignTo=${reassignTo}` : '';
    await apiRequest(`/categories/${id}${qs}`, { method: 'DELETE' });
    await refresh();
  }, [refresh]);

  /** Merge `dropId` into `keepId`: reassigns transactions then soft-deletes the duplicate. */
  const merge = useCallback(async (dropId: number, keepId: number) => {
    await apiRequest(`/categories/${dropId}?reassignTo=${keepId}`, { method: 'DELETE' });
    await refresh();
  }, [refresh]);

  return { data, duplicates, loading, error, refresh, create, rename, remove, merge };
}
