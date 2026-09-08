import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api/client';

/**
 * Campos con sus lotes, de `/fields-tree` (gate `fields`, que es free).
 *
 * NO usar `/observations/filters` para esto: está gateado por `agronomy` y a
 * un usuario sin esa feature le deja el selector vacío en silencio.
 */
export interface TreePlot {
  id: number;
  name: string;
  hectares: number | null;
  activeCrop: string | null;
}

export interface TreeField {
  id: number;
  name: string;
  plots: TreePlot[];
}

interface FieldsTreeResponse {
  fields: TreeField[];
}

export function useFieldsTree() {
  const [fields, setFields] = useState<TreeField[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<FieldsTreeResponse>('/fields-tree');
      const sorted = [...data.fields]
        .sort((a, b) => a.name.localeCompare(b.name, 'es'))
        .map(f => ({ ...f, plots: [...f.plots].sort((a, b) => a.name.localeCompare(b.name, 'es')) }));
      setFields(sorted);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No pude cargar tus campos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  return { fields, loading, error, reload };
}
