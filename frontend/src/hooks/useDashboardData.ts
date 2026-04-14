import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';

interface RecentItem {
  type: 'expense' | 'income' | 'activity';
  description: string | null;
  amount: number | null;
  currency: string | null;
  event_type: string | null;
  date: string;
  field_name: string | null;
  plot_name: string | null;
}

export interface DashboardData {
  expenses_month_ars: number;
  expenses_prev_month_ars: number;
  incomes_month_ars: number;
  incomes_prev_month_ars: number;
  activities_month_count: number;
  recent_items: RecentItem[];
  stock_alerts_count?: number;
  livestock_total?: number;
}

export function useDashboardData() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<DashboardData>('/dashboard');
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar resumen');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
