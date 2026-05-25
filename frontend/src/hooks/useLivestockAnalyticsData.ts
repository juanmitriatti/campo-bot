import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';

export interface LivestockStockCategoryRow {
  category: string;
  headcount: number;
}

export interface LivestockHeadcountMonth {
  month: string;
  label: string;
  byCategory: Record<string, number>; // monthly net delta per category
}

export interface FeedlotWeightCurveGroup {
  groupId: string;
  groupLabel: string;
  corralName: string;
  points: Array<{ date: string; avgWeightKg: number }>;
}

export interface AvgWeightCategoryRow {
  category: string;
  avgWeightKg: number;
  lastWeighedAt: string;
}

export interface MonthlyEventsByType {
  month: string;
  label: string;
  byType: Record<string, number>;
}

export interface FeedlotOccupancyRow {
  corralId: number;
  corralName: string;
  capacity: number | null;
  currentHeadcount: number;
  feedlotName?: string | null;
  fieldName?: string | null;
  animalsDescription?: string;
}

export interface LivestockAnalyticsData {
  stockByCategory: LivestockStockCategoryRow[];
  headcountTrendMonthly: LivestockHeadcountMonth[];
  feedlotWeightCurve: FeedlotWeightCurveGroup[];
  avgWeightByCategory: AvgWeightCategoryRow[];
  healthEventsMonthly: MonthlyEventsByType[];
  reproEventsMonthly: MonthlyEventsByType[];
  feedlotOccupancy: FeedlotOccupancyRow[];
}

export function useLivestockAnalyticsData(fieldId: number | null) {
  const [data, setData] = useState<LivestockAnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = fieldId == null
        ? '/analytics/livestock?field_id=all'
        : `/analytics/livestock?field_id=${fieldId}`;
      const json = await apiRequest<LivestockAnalyticsData>(url);
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar dashboard ganadero');
    } finally {
      setLoading(false);
    }
  }, [fieldId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { data, loading, error, refresh };
}
