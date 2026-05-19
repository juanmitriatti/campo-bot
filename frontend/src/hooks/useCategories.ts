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

export function useCategories(kind: CategoryKind) {
  const [data, setData] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiRequest<ListResponse>(`/categories?kind=${kind}`);
      setData(r.categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar categorías');
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async (name: string) => {
    await apiRequest('/categories', { method: 'POST', body: { kind, name } });
    await refresh();
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

  return { data, loading, error, refresh, create, rename, remove };
}
