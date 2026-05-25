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
    setLoading(true);
    setError(null);
    try {
      // fieldId === null → "Todos los campos" view: aggregate across all user fields.
      const url = fieldId == null ? '/analytics?field_id=all' : `/analytics?field_id=${fieldId}`;
      const json = await apiRequest<AnalyticsData>(url);
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
