import { useState, useEffect } from 'react';
import { apiRequest } from '../api/client';

export interface UserField {
  id: number;
  name: string;
}

interface MapDataResponse {
  fields: Array<{ id: number; name: string }>;
}

export function useUserFields() {
  const [fields, setFields] = useState<UserField[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<MapDataResponse>('/map-data')
      .then(json => {
        if (cancelled) return;
        const sorted = [...json.fields]
          .map(f => ({ id: f.id, name: f.name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'es'));
        setFields(sorted);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Error al cargar campos');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { fields, loading, error };
}
