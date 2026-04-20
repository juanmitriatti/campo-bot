import { useState, useEffect } from 'react';
import { apiRequest } from '../api/client';

interface Field {
  id: number;
  name: string;
  lat: number | null;
  lng: number | null;
  polygon: any;
  city: string | null;
}

interface Plot {
  id: number;
  name: string;
  fieldId: number;
  areaHectares: number | null;
  activeCrop: string | null;
  cropStatus: 'active' | 'harvested' | 'idle';
}

export interface MapData {
  fields: Field[];
  plots: Plot[];
}

export function useMapData() {
  const [data, setData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const json = await apiRequest<MapData>('/map-data');
        setData(json);
      } catch {
        // Silently fail - map is optional
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  return { data, loading };
}
