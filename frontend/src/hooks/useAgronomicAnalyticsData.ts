import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';

export interface AgronomicRainfallMonth {
  month: string;
  label: string;
  mm: number;
}

export interface AgronomicHarvestMonth {
  month: string;
  label: string;
  crop: string | null;
  plotName: string | null;
  totalKg: number | null;
  yieldKgPerHa: number | null;
}

export interface ScoutingByPlot {
  plotId: number;
  plotName: string;
  fieldId: number;
  fieldName: string;
  fieldLat: number | null;
  fieldLng: number | null;
  weedCoveragePct: number | null;
  weedSpecies: string[];
  pestSpecies: string | null;
  pestSeverity1to5: number | null;
  scoutedAt: string;
}

export interface YieldByCropRow {
  crop: string;
  avgKgPerHa: number | null;
  harvests: number;
}

export interface FieldPlotCropEntry {
  crop: string;
  hectares: number | null; // sowed_hectares (null = todo el lote)
}

export interface FieldPlotEntry {
  plotId: number;
  plotName: string;
  hectares: number | null;
  crops: FieldPlotCropEntry[]; // vacio = sin sembrar; soporta N cultivos
}

export interface FieldPlotCropsField {
  fieldId: number;
  fieldName: string;
  plots: FieldPlotEntry[];
}

export interface HarvestQualityLoad {
  loadId: number;
  crop: string | null;
  humidityPct: number;
  quality: Record<string, number>;
  plotName: string | null;
  harvestedAt: string;
}

export interface AgronomicAnalyticsData {
  rainfallMonthly: AgronomicRainfallMonth[];
  harvestsMonthly: AgronomicHarvestMonth[];
  scoutingByPlot: ScoutingByPlot[];
  yieldByCrop: YieldByCropRow[];
  fieldPlotCrops: FieldPlotCropsField[];
  harvestQualityLoads: HarvestQualityLoad[];
}

export function useAgronomicAnalyticsData(fieldId: number | null) {
  const [data, setData] = useState<AgronomicAnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // fieldId === null → "Todos los campos" view: aggregate across all user fields.
      const url = fieldId == null
        ? '/analytics/agronomic?field_id=all'
        : `/analytics/agronomic?field_id=${fieldId}`;
      const json = await apiRequest<AgronomicAnalyticsData>(url);
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar dashboard agronómico');
    } finally {
      setLoading(false);
    }
  }, [fieldId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { data, loading, error, refresh };
}
