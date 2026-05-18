import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';

interface MonthlyTrend {
  month: string;
  label: string;
  expenses: number;
  incomes: number;
}

interface RainfallDaily {
  date: string;
  label: string;
  mm: number;
}

export interface BreakdownRow {
  plotId: number | null;
  plotName: string | null;
  fieldName: string | null;
  category: string;
  currency: string;
  total: number;
}

interface AnalyticsData {
  monthlyTrend: MonthlyTrend[];
  rainfallDaily: RainfallDaily[];
  expenseBreakdown: BreakdownRow[];
  incomeBreakdown: BreakdownRow[];
}

export function useAnalyticsData(fieldId: number | null) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (fieldId == null) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const json = await apiRequest<AnalyticsData>(`/analytics?field_id=${fieldId}`);
      setData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [fieldId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
